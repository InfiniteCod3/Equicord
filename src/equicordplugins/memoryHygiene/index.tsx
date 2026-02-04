/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Button, ChannelStore, MessageCache, MessageStore, SelectedChannelStore, Toasts } from "@webpack/common";

const logger = new Logger("MemoryHygiene");

const settings = definePluginSettings({
    maxMessagesPerChannel: {
        type: OptionType.NUMBER,
        description: "Max messages to keep in memory per non-active channel",
        default: 1500
    },
    maxCachedChannels: {
        type: OptionType.NUMBER,
        description: "Number of recently visited channels to keep untouched",
        default: 25
    },
    cleanupDelaySeconds: {
        type: OptionType.NUMBER,
        description: "Delay after channel switch before trimming caches",
        default: 45
    },
    showAutoCleanupToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast after automatic cleanups",
        default: false
    },
    enableIdleCleanup: {
        type: OptionType.BOOLEAN,
        description: "Trim caches only when you've been idle for a while",
        default: false
    },
    idleMinutes: {
        type: OptionType.NUMBER,
        description: "Minutes of inactivity before running idle cleanup",
        default: 15
    },
    keepCurrentChannel: {
        type: OptionType.BOOLEAN,
        description: "Never trim the currently open channel",
        default: true
    },
    manualCleanup: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => (
            <Button onClick={() => runCleanup(true)}>
                Run Cleanup Now
            </Button>
        )
    },
    previewCleanup: {
        type: OptionType.COMPONENT,
        description: "",
        component: () => (
            <Button onClick={() => runPreview()}>
                Preview Cleanup
            </Button>
        )
    }
});

const recentChannels: string[] = [];
let cleanupTimeout: number | null = null;
let idleInterval: number | null = null;
let lastChannelId: string | null = null;
let lastActivity = Date.now();
let teardownActivityListeners: (() => void) | null = null;
let removeChannelListener: (() => void) | null = null;

function recordChannel(channelId: string) {
    const idx = recentChannels.indexOf(channelId);
    if (idx !== -1) recentChannels.splice(idx, 1);
    recentChannels.unshift(channelId);
    const max = Math.max(1, Math.floor(settings.store.maxCachedChannels));
    if (recentChannels.length > max) recentChannels.length = max;
}

function scheduleCleanup() {
    if (cleanupTimeout != null) clearTimeout(cleanupTimeout);
    const delayMs = Math.max(5, Math.floor(settings.store.cleanupDelaySeconds)) * 1000;
    cleanupTimeout = window.setTimeout(() => runCleanup(settings.store.showAutoCleanupToast), delayMs);
}

function getCachedChannelIds(): string[] {
    const raw = (MessageCache as any)?._channelMessages;
    if (!raw) return [];
    if (raw instanceof Map) return Array.from(raw.keys());
    if (typeof raw === "object") return Object.keys(raw);
    return [];
}

function getMessagesForChannel(channelId: string): Message[] {
    const store = MessageStore.getMessages(channelId);
    if (!store) return [];

    if (Array.isArray((store as any)._array)) {
        return (store as any)._array as Message[];
    }

    const mapLike = (store as any)._map;
    if (mapLike) {
        if (mapLike instanceof Map) return Array.from(mapLike.values());
        return Object.values(mapLike) as Message[];
    }

    return [];
}

function trimChannel(channelId: string, maxMessages: number): number {
    if (maxMessages <= 0) return 0;

    const cache = (MessageCache as any).getOrCreate?.(channelId);
    if (!cache || typeof cache.remove !== "function") return 0;

    const messages = getMessagesForChannel(channelId);
    if (messages.length <= maxMessages) return 0;

    const sorted = [...messages].sort((a, b) => {
        const ta = new Date(a.timestamp?.toString?.() ?? a.timestamp).getTime();
        const tb = new Date(b.timestamp?.toString?.() ?? b.timestamp).getTime();
        return ta - tb;
    });

    const toRemove = sorted.slice(0, Math.max(0, sorted.length - maxMessages));
    let updated = cache;
    for (const msg of toRemove) {
        if (!msg?.id) continue;
        updated = updated.remove(msg.id);
    }

    if (updated !== cache) {
        (MessageCache as any).commit(updated);
    }

    return toRemove.length;
}

function getChannelLabel(channelId: string): string {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return channelId;
    if (channel.isDM?.() || channel.isGroupDM?.()) return channel.name || channelId;
    return channel.name ? `#${channel.name}` : channelId;
}

function buildTrimPlan() {
    const activeChannelId = SelectedChannelStore.getChannelId();
    const protectedChannels = new Set<string>();

    if (settings.store.keepCurrentChannel && activeChannelId) {
        protectedChannels.add(activeChannelId);
    }

    for (const id of recentChannels) protectedChannels.add(id);

    const channelIds = getCachedChannelIds();
    const maxMessages = Math.max(50, Math.floor(settings.store.maxMessagesPerChannel));

    const plan: Array<{ channelId: string; removeCount: number; }> = [];
    for (const channelId of channelIds) {
        if (!channelId || protectedChannels.has(channelId)) continue;
        const messages = getMessagesForChannel(channelId);
        const removeCount = Math.max(0, messages.length - maxMessages);
        if (removeCount > 0) {
            plan.push({ channelId, removeCount });
        }
    }

    return plan;
}

function runCleanup(showToast: boolean) {
    try {
        const plan = buildTrimPlan();

        let totalRemoved = 0;
        for (const entry of plan) {
            totalRemoved += trimChannel(entry.channelId, Math.max(50, Math.floor(settings.store.maxMessagesPerChannel)));
        }

        if (showToast) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.SUCCESS,
                message: `Cleanup complete. Trimmed ${totalRemoved} messages across ${plan.length} channels.`
            });
        }
    } catch (err) {
        logger.error("Cleanup failed", err);
        if (showToast) {
            Toasts.show({
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE,
                message: "Cleanup failed. Check console for details."
            });
        }
    }
}

function runPreview() {
    try {
        const plan = buildTrimPlan();
        const total = plan.reduce((sum, p) => sum + p.removeCount, 0);
        const top = [...plan]
            .sort((a, b) => b.removeCount - a.removeCount)
            .slice(0, 5)
            .map(p => `${getChannelLabel(p.channelId)}: ${p.removeCount}`)
            .join(", ");

        Toasts.show({
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS,
            message: plan.length === 0
                ? "Preview: No cleanup needed."
                : `Preview: ${total} messages across ${plan.length} channels. Top: ${top}`
        });

        if (plan.length > 0) {
            logger.info("Cleanup preview", plan);
        }
    } catch (err) {
        logger.error("Preview failed", err);
        Toasts.show({
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE,
            message: "Preview failed. Check console for details."
        });
    }
}

function setupIdleCleanup() {
    if (!settings.store.enableIdleCleanup) return;

    const onActivity = () => {
        lastActivity = Date.now();
    };

    const events = ["mousemove", "keydown", "click", "scroll"];
    events.forEach(evt => window.addEventListener(evt, onActivity, { passive: true }));

    teardownActivityListeners = () => {
        events.forEach(evt => window.removeEventListener(evt, onActivity));
    };

    const intervalMs = Math.max(1, Math.floor(settings.store.idleMinutes)) * 60 * 1000;
    idleInterval = window.setInterval(() => {
        if (Date.now() - lastActivity >= intervalMs) {
            runCleanup(false);
        }
    }, intervalMs);
}

export default definePlugin({
    name: "MemoryHygiene",
    description: "Trim message caches in inactive channels to reduce memory creep",
    authors: [EquicordDevs.veygax],
    settings,
    start() {
        lastChannelId = SelectedChannelStore.getChannelId();
        if (lastChannelId) recordChannel(lastChannelId);

        const onChannelChange = () => {
            const current = SelectedChannelStore.getChannelId();
            if (!current || current === lastChannelId) return;
            lastChannelId = current;
            recordChannel(current);
            scheduleCleanup();
        };

        SelectedChannelStore.addChangeListener(onChannelChange);
        removeChannelListener = () => SelectedChannelStore.removeChangeListener(onChannelChange);
        setupIdleCleanup();
    },
    stop() {
        if (cleanupTimeout != null) clearTimeout(cleanupTimeout);
        cleanupTimeout = null;

        if (idleInterval != null) clearInterval(idleInterval);
        idleInterval = null;

        if (teardownActivityListeners) {
            teardownActivityListeners();
            teardownActivityListeners = null;
        }

        if (removeChannelListener) {
            removeChannelListener();
            removeChannelListener = null;
        }
    }
});
