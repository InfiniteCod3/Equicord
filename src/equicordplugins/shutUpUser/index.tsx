/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Menu } from "@webpack/common";

// Settings for this plugin
const settings = definePluginSettings({
    debugLogs: {
        type: OptionType.BOOLEAN,
        description: "Enable console debug logs",
        default: false
    }
});

// Simple debug logger for this plugin (controlled via settings)
const log = (...args: any[]) => {
    if (!settings.store.debugLogs) return;
    console.log("[ShutUpUser]", ...args);
};

const DATA_KEY = "ShutUpUser_suppressedIds";

let suppressedUsers = new Set<string>();

async function loadSuppressed() {
    try {
        const list = await DataStore.get<string[]>(DATA_KEY);
        suppressedUsers = new Set(list ?? []);
        log("Loaded suppressed list:", Array.from(suppressedUsers));
    } catch {
        suppressedUsers = new Set();
        log("No suppressed list found. Starting fresh.");
    }
}

async function persist() {
    try {
        await DataStore.set(DATA_KEY, Array.from(suppressedUsers));
        log("Persisted suppressed list:", Array.from(suppressedUsers));
    } catch {
        // ignore
    }
}

function isSuppressed(id?: string | null) {
    return !!id && suppressedUsers.has(id);
}

async function toggleSuppressed(id: string, username?: string) {
    log("Toggling suppression:", { id, username, currentlySuppressed: suppressedUsers.has(id) });
    if (suppressedUsers.has(id)) suppressedUsers.delete(id);
    else suppressedUsers.add(id);
    await persist();
    // Small toast to confirm the toggle
    const enabled = suppressedUsers.has(id);
    log("Suppression now:", { id, enabled });
    showNotification({
        title: enabled ? "Shut up enabled" : "Shut up disabled",
        body: enabled ? `Now silencing ${username ?? "this user"}` : `No longer silencing ${username ?? "this user"}`
    });
}

const UserContext: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user) return;

    log("Rendering user-context menu for:", { id: user.id, username: user.username });
    const checked = isSuppressed(user.id);
    children.splice(-1, 0, (
        <Menu.MenuGroup>
            <Menu.MenuCheckboxItem
                id="equicord-shut-up-user"
                label="Shut up"
                checked={checked}
                action={() => toggleSuppressed(user.id, user.username)}
            />
        </Menu.MenuGroup>
    ));
};

export default definePlugin({
    name: "ShutUpUser",
    description: "Adds a 'Shut up' option to the user context menu that silences message notification sounds from that user without muting them.",
    authors: [EquicordDevs.nobody],
    settings,
    start: loadSuppressed,
    contextMenus: {
        "user-context": UserContext
    },
    patches: [
        {
            // Use the same anchor as OnePingPerDM for stability
            find: ".getDesktopType()===",
            replacement: [
                {
                    match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)/,
                    replace: "$&if(!$self.allowSound(arguments[0]?.message))return;else "
                },
                {
                    match: /sound:(\i\?\i:void 0,soundpack:\i,volume:\i,onClick)/,
                    replace: "sound:!$self.allowSound(arguments[0]?.message)?undefined:$1"
                }
            ]
        }
    ],
    allowSound(message?: { author?: { id?: string; }; }) {
        const authorId = message?.author?.id;
        if (!authorId) {
            log("allowSound: missing authorId; allowing sound", { messagePresent: !!message });
            return true;
        }
        const suppressed = isSuppressed(authorId);
        if (suppressed) {
            log("allowSound: blocking sound for suppressed author", { authorId });
        } else {
            log("allowSound: allowing sound for author", { authorId });
        }
        return !suppressed;
    }
});
