'use strict';

const fs = require('fs');
const path = require('path');

const MAX_TEXT_LENGTH = 200;
const MAX_LINK_URL_LENGTH = 2048;
const MAX_ANNOUNCEMENT_ITEMS = 10;

function createDefaultAnnouncement() {
    return {
        schemaVersion: 4,
        enabled: false,
        items: [],
        text: '',
        linkUrl: '',
        links: [],
        updatedAt: null
    };
}

function normalizeAnnouncementLinkUrl(input) {
    const rawUrl = String(input || '').trim();
    if (!rawUrl) return '';
    if (rawUrl.length > MAX_LINK_URL_LENGTH) throw new Error('跳转地址过长');

    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl);
    } catch (_) {
        throw new Error('跳转地址格式不正确');
    }
    if (parsedUrl.protocol !== 'https:') throw new Error('跳转地址必须使用 HTTPS');
    if (parsedUrl.username || parsedUrl.password) throw new Error('跳转地址不能包含账号或密码');

    return parsedUrl.href;
}

/**
 * 校验并规范化公告配置。同时保留首条公告的旧字段，便于新旧插件分步升级。
 */
function normalizeAnnouncement(input, { forSave = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('公告配置必须是对象');
    }

    const enabled = input.enabled === true;
    const legacyLink = Array.isArray(input.links) ? input.links[0] : null;
    const rawItems = Array.isArray(input.items)
        ? input.items
        : [{
            id: 'announcement-1',
            enabled: true,
            text: input.text,
            linkUrl: input.linkUrl || (legacyLink && legacyLink.url) || ''
        }];

    if (rawItems.length > MAX_ANNOUNCEMENT_ITEMS) {
        throw new Error(`公告最多配置 ${MAX_ANNOUNCEMENT_ITEMS} 条`);
    }

    const usedIds = new Set();
    const items = rawItems.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`第 ${index + 1} 条公告格式不正确`);
        }
        const text = String(item.text || '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (text.length > MAX_TEXT_LENGTH) {
            throw new Error(`第 ${index + 1} 条公告文字不能超过 ${MAX_TEXT_LENGTH} 个字符`);
        }
        const itemEnabled = item.enabled !== false;
        if (enabled && itemEnabled && !text) throw new Error(`第 ${index + 1} 条启用公告必须填写文字`);

        const itemLink = Array.isArray(item.links) ? item.links[0] : null;
        const linkUrl = normalizeAnnouncementLinkUrl(item.linkUrl || (itemLink && itemLink.url) || '');
        const rawId = String(item.id || `announcement-${index + 1}`).trim();
        let id = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || `announcement-${index + 1}`;
        if (usedIds.has(id)) id = `${id.slice(0, 56)}-${index + 1}`;
        usedIds.add(id);
        return { id, enabled: itemEnabled, text, linkUrl };
    }).filter((item) => item.text);

    const visibleItems = items.filter((item) => item.enabled);
    if (enabled && visibleItems.length === 0) throw new Error('启用公告时至少需要一条已启用的公告');
    const firstItem = visibleItems[0] || items[0] || { text: '', linkUrl: '' };
    const links = visibleItems
        .filter((item) => item.linkUrl)
        .map((item) => ({ text: item.text, url: item.linkUrl }));

    let updatedAt = input.updatedAt || null;
    if (updatedAt && Number.isNaN(Date.parse(updatedAt))) updatedAt = null;
    if (forSave) updatedAt = new Date().toISOString();

    return {
        schemaVersion: 4,
        enabled,
        items,
        text: firstItem.text,
        linkUrl: firstItem.linkUrl,
        links,
        updatedAt
    };
}

/**
 * SDK 内置公告文件适配器。新插件只需配置文件路径，无需重复实现存储与校验。
 */
class DefaultFileAnnouncementAdapter {
    constructor(configPath) {
        if (!configPath) throw new Error('[AHSZ SDK] ANNOUNCEMENT_CONFIG_PATH is required');
        this.configPath = path.resolve(configPath);
        this.writeLock = false;
        this.supportsLinks = true;
        this.supportsMultipleItems = true;
    }

    async get() {
        if (!fs.existsSync(this.configPath)) {
            return { code: 0, announcement: createDefaultAnnouncement() };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
            return { code: 0, announcement: normalizeAnnouncement(parsed) };
        } catch (error) {
            throw new Error(`公告配置文件无效: ${error.message}`);
        }
    }

    async save(payload) {
        if (this.writeLock) throw new Error('公告配置正在更新，请稍后重试');
        const announcement = normalizeAnnouncement(payload, { forSave: true });
        const tempPath = `${this.configPath}.tmp.${process.pid}.${Date.now()}`;
        this.writeLock = true;
        try {
            fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
            fs.writeFileSync(tempPath, `${JSON.stringify(announcement, null, 4)}\n`, { encoding: 'utf8', mode: 0o640 });
            const fileDescriptor = fs.openSync(tempPath, 'r+');
            try {
                fs.fsyncSync(fileDescriptor);
            } finally {
                fs.closeSync(fileDescriptor);
            }
            fs.renameSync(tempPath, this.configPath);
            return { code: 0, message: 'success', announcement };
        } catch (error) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
            throw error;
        } finally {
            this.writeLock = false;
        }
    }
}

module.exports = {
    MAX_TEXT_LENGTH,
    MAX_LINK_URL_LENGTH,
    MAX_ANNOUNCEMENT_ITEMS,
    createDefaultAnnouncement,
    normalizeAnnouncement,
    DefaultFileAnnouncementAdapter
};
