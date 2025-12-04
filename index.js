import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, log } from 'crawlee';

// Initialize Actor
await Actor.init();

// ==================== INPUT CONFIGURATION ====================
const input = await Actor.getInput() ?? {};
const {
    pincode = '411001',
    searchQueries = [],
    searchUrls = [],
    maxProductsPerSearch = 100,
    maxRequestRetries = 3,
    navigationTimeout = 60000,
    headless = true,
    proxyConfiguration = { useApifyProxy: false },
    scrollCount = 20, // Increased default scroll count
} = input;

// ==================== CONSTANTS & SELECTORS ====================
const SELECTORS = {
    // Location / Pincode
    locationButton: [
        'button[aria-label="Select Location"]',
        'button.__4y7HY',
        'div.a0Ppr button'
    ],
    locationModal: 'div[data-testid="address-modal"]',
    searchInput: 'div[data-testid="address-search-input"] input[type="text"]',
    searchResultItem: 'div[data-testid="address-search-item"]',
    
    // Products
    productLink: 'a.B4vNQ',
    productCard: 'div.cavQgJ.cTH4Df', // Fallback if link doesn't contain everything
    
    // Product Details (Inside card)
    productName: [
        'div[data-slot-id="ProductName"] span',
        'div.cQAjo6.ch5GgP span',
        'h3', 
        'h2'
    ],
    productImage: 'img',
    priceSpan: 'span', // We'll iterate spans to find price
    packSize: '[data-slot-id="PackSize"] span',
    rating: '[data-slot-id="RatingInformation"]',
    sponsorTag: '[data-slot-id="SponsorTag"]',
    
    // Search / Listing
    searchResultsContainer: 'div.grid', // Generic grid container, might need adjustment
};

// ==================== HELPER FUNCTIONS ====================

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Sets the pincode location on the page.
 */
async function setPincode(page, log, targetPincode) {
    try {
        log.info(`🎯 Setting location to pincode: ${targetPincode}`);
        
        await page.waitForLoadState('domcontentloaded');
        await delay(1500);
        
        let clicked = false;
        for (const selector of SELECTORS.locationButton) {
            try {
                const button = page.locator(selector).first();
                if (await button.count() > 0) {
                    await button.click({ timeout: 3000 });
                    log.info(`✓ Clicked location button: ${selector}`);
                    clicked = true;
                    break;
                }
            } catch (e) {
                continue;
            }
        }
        
        if (!clicked) {
            log.warning('⚠️ Location button not found');
            return false;
        }
        
        await delay(1000);
        
        try {
            await page.waitForSelector(SELECTORS.locationModal, { timeout: 5000 });
        } catch (e) {
            log.warning('⚠️ Location modal not detected');
            return false;
        }
        
        await delay(800);
        
        const searchInput = page.locator(SELECTORS.searchInput).first();
        
        if (await searchInput.count() === 0) {
            log.error('❌ Search input not found in modal');
            return false;
        }
        
        await searchInput.focus();
        await delay(200);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await delay(200);
        await searchInput.type(targetPincode, { delay: 80 });
        
        await delay(1500);
        
        try {
            await page.waitForSelector(SELECTORS.searchResultItem, { timeout: 5000 });
        } catch (e) {
            log.error('❌ No address results appeared');
            return false;
        }
        
        const firstAddress = page.locator(SELECTORS.searchResultItem).first();
        
        if (await firstAddress.count() > 0) {
            await firstAddress.click({ force: true });
            await delay(1500);
            
            const modalStillOpen = await page.locator(SELECTORS.locationModal).count();
            if (modalStillOpen === 0) {
                log.info('✅ Location set successfully');
                return true;
            }
        }
        
        return false;
    } catch (error) {
        log.error(`❌ Error setting pincode: ${error.message}`);
        return false;
    }
}

/**
 * Auto-scrolls the page to load dynamic content.
 * Scrolls to bottom, waits for height change, and retries if needed.
 */
async function autoScroll(page, log, maxScrolls = 20) {
    try {
        log.info(`🔄 Auto-scrolling up to ${maxScrolls} times...`);
        
        let previousHeight = await page.evaluate('document.body.scrollHeight');
        let noChangeCount = 0;
        
        for (let i = 0; i < maxScrolls; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(2000); // Wait for content to load
            
            const newHeight = await page.evaluate('document.body.scrollHeight');
            
            if (newHeight === previousHeight) {
                noChangeCount++;
                // Try scrolling up a bit and back down to trigger observers
                if (noChangeCount === 1) {
                    await page.evaluate(() => window.scrollBy(0, -500));
                    await delay(500);
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                    await delay(1000);
                }
                
                if (noChangeCount >= 3) {
                    log.info(`✓ Reached bottom or no new content after ${i + 1} scrolls`);
                    break;
                }
            } else {
                noChangeCount = 0;
                previousHeight = newHeight;
                log.info(`  - Scroll ${i + 1}/${maxScrolls}: Content loaded (Height: ${newHeight})`);
            }
        }
        
        // Scroll back to top to ensure all elements are rendered/hydrated if needed
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(500);
        
    } catch (error) {
        log.warning(`Auto-scroll failed: ${error.message}`);
    }
}

/**
 * Waits for search results to appear on the page.
 */
async function waitForSearchResults(page, log) {
    try {
        await page.waitForSelector(SELECTORS.productLink, { timeout: 10000 });
        const count = await page.locator(SELECTORS.productLink).count();
        if (count > 0) {
            await delay(500);
            return true;
        }
    } catch (e) {
        // Fallback check
        try {
            const bodyText = await page.evaluate(() => document.body.innerText || '');
            if (bodyText.includes('₹') || /\bADD\b/i.test(bodyText)) {
                return true;
            }
        } catch (err) {
            // Ignore
        }
    }
    
    log.warning('No search results found');
    return false;
}

function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ==================== CRAWLER SETUP ====================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

const proxyConfig = proxyConfiguration?.useApifyProxy 
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxRequestRetries,
    navigationTimeoutSecs: navigationTimeout / 1000,
    headless,
    
    launchContext: {
        launchOptions: {
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-software-rasterizer'
            ],
        }
    },

    preNavigationHooks: [
        async ({ page, log }) => {
            try {
                const ua = pickRandom(USER_AGENTS);

                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'User-Agent': ua
                });

                await page.setViewportSize({ width: 1920, height: 1080 });

                await page.addInitScript((ua) => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(navigator, 'userAgent', { get: () => ua });
                }, ua).catch(() => {});
            } catch (e) {
                log.error(`preNavigationHook error: ${e.message}`);
            }
        }
    ],

    async requestHandler({ page, request, log }) {
        const { url } = request;
        const isFirstRequest = request.userData?.isFirst || false;

        log.info(`🔍 Processing: ${url}`);

        try {
            // Handle Location
            if (isFirstRequest) {
                await setPincode(page, log, pincode);
                await delay(1500);
            }
            
            await page.waitForLoadState('domcontentloaded');
            await delay(2000);
            
            // Close popups
            try {
                const closeButton = page.locator('button[aria-label*="Close"]').first();
                if (await closeButton.count() > 0) {
                    await closeButton.click({ timeout: 1500 });
                }
            } catch (e) {
                // No popup
            }
            
            const resultsFound = await waitForSearchResults(page, log);
            
            if (!resultsFound) {
                log.warning('⚠️ No search results detected');
                return;
            }
            
            await autoScroll(page, log, scrollCount);
            
            // Extract Data
            const products = await page.evaluate((selectors) => {
                const productCards = [];
                const productLinks = document.querySelectorAll(selectors.productLink);

                function textOrNull(el) {
                    return el ? (el.textContent || '').trim() : null;
                }

                productLinks.forEach((link, index) => {
                    try {
                        const productUrl = link.href;
                        const urlMatch = productUrl.match(/\/pn\/([^/]+)\/pvid\/([^/]+)/) || 
                                       productUrl.match(/\/(?:p|product)\/([^/]+)\/([^/]+)/);
                        const productSlug = urlMatch?.[1] || null;
                        const productId = urlMatch?.[2] || `zepto-${index}`;

                        const card = link.querySelector(selectors.productCard) || link;

                        // Name extraction
                        let productName = null;
                        for (const sel of selectors.productName) {
                            const el = card.querySelector(sel);
                            if (el && textOrNull(el)) {
                                productName = textOrNull(el);
                                break;
                            }
                        }
                        if (!productName) {
                            productName = link.getAttribute('title') || 
                                        link.querySelector('img')?.alt || null;
                        }

                        // Image
                        const imgEl = card.querySelector(selectors.productImage) || link.querySelector('img');
                        const productImage = imgEl?.src || imgEl?.getAttribute('data-src') || null;

                        // Price
                        let currentPrice = null;
                        const spans = Array.from(card.querySelectorAll(selectors.priceSpan));
                        for (const s of spans) {
                            const match = (s.textContent || '').match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                            if (match) {
                                currentPrice = parseFloat(match[1].replace(/,/g, ''));
                                break;
                            }
                        }

                        // Original price
                        let originalPrice = null;
                        const origSpan = spans.find(s => 
                            /(MRP|strike|original)/i.test(s.className || ''));
                        if (origSpan) {
                            const match = (origSpan.textContent || '').match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                            if (match) originalPrice = parseFloat(match[1].replace(/,/g, ''));
                        }

                        // Discount
                        let discountPercentage = null;
                        if (currentPrice && originalPrice && originalPrice > currentPrice) {
                            discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
                        }

                        // Pack size
                        const packSizeEl = card.querySelector(selectors.packSize);
                        const productWeight = packSizeEl ? textOrNull(packSizeEl) : null;

                        // Rating
                        let rating = null;
                        const ratingEl = card.querySelector(selectors.rating);
                        if (ratingEl) {
                            const match = (ratingEl.textContent || '').match(/(\d+\.\d+)/);
                            if (match) rating = parseFloat(match[1]);
                        }

                        const isSponsored = !!card.querySelector(selectors.sponsorTag);
                        const isOutOfStock = card.getAttribute?.('data-is-out-of-stock') === 'true';

                        if (productName || currentPrice || productImage) {
                            productCards.push({
                                productId,
                                productSlug,
                                productName,
                                productImage,
                                currentPrice,
                                originalPrice,
                                discountPercentage,
                                productWeight,
                                rating,
                                isSponsored,
                                isOutOfStock,
                                productUrl,
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    } catch (err) {
                        // console.error(`Error processing product ${index}:`, err);
                    }
                });

                return productCards;
            }, SELECTORS);
            
            if (products.length === 0) {
                log.error('❌ No products extracted');
                return;
            }
            
            const urlParams = new URL(url).searchParams;
            const searchQuery = urlParams.get('query') || request.userData.query;
            
            const productsToSave = products.slice(0, maxProductsPerSearch).map(product => ({
                ...product,
                searchQuery,
                searchUrl: url,
                platform: 'Zepto',
                pincode
            }));
            
            await Dataset.pushData(productsToSave);
            
            log.info(`✅ Saved ${productsToSave.length} products for "${searchQuery}"`);

        } catch (error) {
            log.error(`❌ Error: ${error.message}`);
            throw error;
        }
    },

    failedRequestHandler: async ({ request, log }) => {
        log.error(`❌ Request failed: ${request.url}`);
    }
});

// ==================== EXECUTION ====================

const startUrls = [
    ...searchQueries.map(query => ({
        url: `https://www.zepto.com/search?query=${encodeURIComponent(query)}`,
        userData: { 
            query,
            isFirst: true // Mark as first to trigger location set
        }
    })),
    ...searchUrls.map(url => ({
        url,
        userData: {
            query: 'direct_url',
            isFirst: true
        }
    }))
];

if (startUrls.length > 0) {
    log.info(`🚀 Starting Zepto Scraper with ${startUrls.length} URLs`);
    
    // We only mark the VERY first request as 'isFirst' for location setting if we want to be strict,
    // but since we might need to set location per session, and we have maxConcurrency: 1 (implied or default),
    // we can try to set it on the first one.
    // However, the logic above checks `request.userData.isFirst`.
    // Let's ensure only the first one has it if we want to avoid repeated attempts, 
    // OR we rely on the `locationSetGlobally` flag if we were using a global variable.
    // But `PlaywrightCrawler` creates new pages.
    // The provided code used a global `locationSetGlobally`.
    // We can use a global variable here too since we are in a single process.
    
    // Let's modify the startUrls to only have isFirst on the first item
    startUrls.forEach((u, i) => {
        u.userData.isFirst = (i === 0);
    });

    await crawler.run(startUrls);
    
    log.info('✅ Scraping completed successfully!');
} else {
    log.error('❌ No search URLs or queries provided!');
}

// Exit Actor
await Actor.exit();
