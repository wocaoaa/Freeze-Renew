const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

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

// 清理广告和遮罩层的函数
async function cleanAds(page) {
    console.log('🧹 正在清理可能存在的广告和遮罩层...');
    await page.evaluate(() => {
        // 1. 移除常见的广告选择器 (ID 或 Class)
        const adSelectors = [
            'iframe[id*="google_ads"]', 'div[class*="adsbygoogle"]', 
            '.modal-backdrop', '.ad-container', '#dismiss-button',
            'div[aria-label="Close ad"]', 'ins.adsbygoogle'
        ];
        adSelectors.forEach(s => {
            document.querySelectorAll(s).forEach(el => el.remove());
        });

        // 2. 强制恢复页面滚动（有些广告关闭后会锁定 body）
        document.body.style.overflow = 'auto';
        document.documentElement.style.overflow = 'auto';
    });
    await page.waitForTimeout(1000);
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const msg = [`🎮 FreezeHost 续期通知`, `🕐 运行时间: ${nowStr()}`, `🖥 任务详情:`, result].join('\n');
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
    console.log(`  📄 授权处理中...`);
    const selectors = ['button:has-text("Authorize")', 'button:has-text("授权")', 'button[type="submit"]'];
    for (let i = 0; i < 5; i++) {
        if (!page.url().includes('discord.com')) return;
        await cleanAds(page);
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

test('FreezeHost 自动续期 (增强防广告版)', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('❌ 缺少账号配置');

    let proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    let summaryResults = [];

    try {
        console.log('🔑 登录中...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
        await cleanAds(page);
        
        await page.click('span.text-lg:has-text("Login with Discord")', { force: true });
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click({ force: true });

        await page.waitForURL(/discord\.com\/login/);
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]', { force: true });

        if (page.url().includes('discord.com/oauth2/authorize')) {
            await handleOAuthPage(page);
        }

        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        await page.waitForTimeout(3000);
        await cleanAds(page);

        // 获取所有服务器链接
        const serverUrls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="server-console"]')).map(link => link.href);
        });

        console.log(`📊 发现 ${serverUrls.length} 个服务器`);

        for (let i = 0; i < serverUrls.length; i++) {
            const targetUrl = serverUrls[i];
            const serverId = targetUrl.split('id=')[1] || `S${i+1}`;
            
            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
                await cleanAds(page);

                const statusText = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim() || '未知');
                const daysMatch = statusText.match(/(\d+(?:\.\d+)?)\s*day/i);
                const days = daysMatch ? parseFloat(daysMatch[1]) : null;

                if (days !== null && days > 7) {
                    summaryResults.push(`🟢 服务器 ${serverId}: 剩余 ${days} 天`);
                    continue;
                }

                // 准备点击续期
                const icon = page.locator('i.fa-external-link-alt').first();
                await icon.locator('xpath=..').hover();
                await page.waitForTimeout(1000);
                await icon.click({ force: true });
                
                const renewBtn = page.locator('#renew-link-modal');
                await renewBtn.waitFor({ state: 'visible' });
                
                if ((await renewBtn.innerText()).toLowerCase().includes('renew instance')) {
                    const href = await renewBtn.getAttribute('href');
                    
                    // 核心逻辑：跳转到最终续期页，先清广告，再强制点击
                    await page.goto(new URL(href, page.url()).href);
                    await page.waitForTimeout(2000);
                    await cleanAds(page); // 最终页清理广告

                    // 再次检查是否回到了 dashboard 且 URL 带有结果
                    await page.waitForURL(/success|err|dashboard/, { timeout: 20000 });
                    const res = page.url();
                    if (res.includes('success=RENEWED')) summaryResults.push(`✅ 服务器 ${serverId}: 成功`);
                    else if (res.includes('err=CANNOTAFFORDRENEWAL')) summaryResults.push(`❌ 服务器 ${serverId}: 没钱了`);
                    else summaryResults.push(`⚠️ 服务器 ${serverId}: 状态未知`);
                } else {
                    summaryResults.push(`🟡 服务器 ${serverId}: 暂不可续期`);
                }
            } catch (err) {
                summaryResults.push(`❌ 服务器 ${serverId}: 脚本异常`);
            }
        }
        await sendTG(summaryResults.join('\n'));
    } catch (e) {
        await sendTG(`🚨 全局异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
