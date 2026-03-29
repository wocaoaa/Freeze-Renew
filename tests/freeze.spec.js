const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const fs = require('fs');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const msg = [`🎮 FreezeHost 续期监控`, `🕐 时间: ${nowStr()}`, result].join('\n');
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, (res) => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

async function handleOAuthPage(page) {
    console.log(`  📄 正在处理 Discord 授权...`);
    const selectors = ['button:has-text("Authorize")', 'button:has-text("授权")', 'button[type="submit"]'];
    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;
        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                if (await btn.isVisible()) {
                    await btn.click({ force: true });
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch { continue; }
        }
    }
}

test('FreezeHost 自动续期与全流程监控', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('❌ 配置文件缺失');

    let proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    let summaryResults = [];

    try {
        console.log('🔑 正在登录 FreezeHost...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'networkidle' });
        
        await page.click('span.text-lg:has-text("Login with Discord")', { force: true });
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click({ force: true });

        await page.waitForURL(/discord\.com\/login/);
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]', { force: true });

        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 10000 });
            await handleOAuthPage(page);
        } catch { console.log('ℹ️ 无需手动授权'); }

        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        await page.waitForTimeout(3000);

        // 扫描服务器列表
        const serverUrls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(link => link.href);
        });

        console.log(`📊 扫描完毕，共发现 ${serverUrls.length} 个服务器`);

        for (let i = 0; i < serverUrls.length; i++) {
            const targetUrl = serverUrls[i];
            const serverId = targetUrl.split('id=')[1] || `Server-${i+1}`;
            console.log(`\n🔎 [${i+1}/${serverUrls.length}] 开始处理: ${serverId}`);

            try {
                await page.goto(targetUrl, { waitUntil: 'networkidle' });
                await page.waitForTimeout(3000);

                // 1. 读取文字状态
                const statusText = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim() || '未知');
                const daysMatch = statusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                const days = daysMatch ? parseFloat(daysMatch[1]) : null;

                console.log(`📋 当前状态文字: "${statusText}"`);

                // 2. 点击外链图标，打开弹窗（这是核心动作）
                const icon = page.locator('i.fa-external-link-alt').first();
                await icon.scrollIntoViewIfNeeded();
                await icon.locator('xpath=..').hover();
                await page.waitForTimeout
