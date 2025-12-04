import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();

const {
    searchUrls = [],
    searchQueries = [],
    maxProductsPerSearch = 100,
    proxyConfiguration = { useApifyProxy: false },
    maxRequestRetries = 3,
    navigationTimeout = 90000,
    headless = false,
    screenshotOnError = true,
    debugMode = true,
    scrollCount = 5
} = input;

// Generate search URLs from queries if provided
const allSearchUrls = [
    ...searchUrls,
    ...searchQueries.map(query => `https://blinkit.com/s/?q=${encodeURIComponent(query)}`)
];

const proxyConfig = proxyConfiguration.useApifyProxy 
    ? await Actor.createProxyConfiguration(proxyConfiguration)
    : undefined;

// Auto-scroll to load lazy products
async function autoScroll(page, log, scrollCount = 5) {
    try {
        log.info(`Starting auto-scroll (${scrollCount} iterations)...`);
        
        for (let i = 0; i < scrollCount; i++) {
            await page.evaluate(() => {
                window.scrollBy(0, window.innerHeight);
            });
            
            log.info(`Scroll ${i + 1}/${scrollCount}`);
            await page.waitForTimeout(1500);
        }
        
        // Scroll back to top
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1000);
        
        log.info('Auto-scroll completed');
    } catch (error) {
        log.warning(`Auto-scroll failed: ${error.message}`);
    }
}

// Debug page state
async function debugPageState(page, log, label = 'debug') {
    try {
        const screenshot = await page.screenshot({ fullPage: true });
        await Actor.setValue(`${label}-screenshot-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
        
        const html = await page.content();
        await Actor.setValue(`${label}-html-${Date.now()}.html`, html, { contentType: 'text/html' });
        
        const pageInfo = await page.evaluate(() => {
            return {
                url: window.location.href,
                title: document.title,
                elementCounts: {
                    productCardsById: document.querySelectorAll('div[id][role="button"].tw-relative.tw-flex.tw-h-full.tw-flex-col').length,
                    productTitles: document.querySelectorAll('div.tw-text-300.tw-font-semibold.tw-line-clamp-2').length,
                    priceElements: document.querySelectorAll('div.tw-text-200.tw-font-semibold').length,
                    weightElements: document.querySelectorAll('div.tw-text-200.tw-font-medium.tw-line-clamp-1').length,
                    addButtons: Array.from(document.querySelectorAll('div[role="button"]')).filter(el => (el.textContent || '').includes('ADD')).length,
                    images: document.querySelectorAll('img').length
                }
            };
        });
        
        log.info(`Page state: ${JSON.stringify(pageInfo, null, 2)}`);
        return pageInfo;
    } catch (error) {
        log.error(`Debug failed: ${error.message}`);
    }
}

// Wait for search results to load
async function waitForSearchResults(page, log) {
    const selectors = [
        'div[id][role="button"].tw-relative',
        'div.tw-text-300.tw-font-semibold.tw-line-clamp-2',
        'div.tw-text-200.tw-font-semibold',
        'img[src*="cdn.grofers.com"]'
    ];
    
    log.info('Waiting for search results to load...');
    
    for (const selector of selectors) {
        try {
            await page.waitForSelector(selector, { timeout: 15000 });
            const count = await page.locator(selector).count();
            log.info(`✓ Found ${count} elements matching: ${selector}`);
            
            if (count > 0) {
                await page.waitForTimeout(2000);
                return true;
            }
        } catch (error) {
            log.warning(`Selector ${selector} not found: ${error.message}`);
        }
    }
    
    log.warning('No search result selectors found');
    return false;
}

// Extract products from search results page - UPDATED WITH CORRECT SELECTORS
async function extractSearchProducts(page, log) {
    try {
        log.info('🔍 Starting product extraction from search results...');
        
        const products = await page.evaluate(() => {
            const productCards = [];
            
            // CORRECT SELECTOR: Product cards have id attribute and specific classes
            // Each product is: <div tabindex="0" role="button" class="tw-relative tw-flex tw-h-full tw-flex-col..." id="PRODUCT_ID">
            const productItems = document.querySelectorAll('div[id][role="button"][tabindex="0"].tw-relative.tw-flex.tw-h-full.tw-flex-col');
            console.log('Extracting products using ID-based selector...',productItems);
            console.log(`Found ${productItems.length} product cards with ID attribute`);
            
            productItems.forEach((item, index) => {
                try {
                    // Extract product ID from the div id attribute
                    const productId = item.id;
                    
                    // Extract product name
                    // Selector: div.tw-text-300.tw-font-semibold.tw-line-clamp-2
                    const titleElement = item.querySelector('div.tw-text-300.tw-font-semibold.tw-line-clamp-2');
                    const productName = titleElement ? titleElement.textContent.trim() : null;
                    
                    // Extract product image
                    // Look for img tag inside the product card
                    const imgElement = item.querySelector('img[src*="cdn.grofers.com"]') || item.querySelector('img');
                    let productImage = null;
                    if (imgElement) {
                        productImage = imgElement.src || imgElement.getAttribute('src');
                    }
                    
                    // Extract weight/quantity
                    // Selector: div.tw-text-200.tw-font-medium.tw-line-clamp-1 (inside items-center flex)
                    const weightElement = item.querySelector('div.tw-flex.tw-items-center div.tw-text-200.tw-font-medium.tw-line-clamp-1');
                    const productWeight = weightElement ? weightElement.textContent.trim() : null;
                    
                    // Extract current price
                    // Selector: div.tw-text-200.tw-font-semibold (that contains ₹)
                    const priceElements = item.querySelectorAll('div.tw-text-200.tw-font-semibold');
                    let currentPrice = null;
                    let originalPrice = null;
                    
                    priceElements.forEach(priceEl => {
                        const priceText = priceEl.textContent.trim();
                        if (priceText.includes('₹')) {
                            const priceMatch = priceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                            if (priceMatch) {
                                const price = parseFloat(priceMatch[1].replace(/,/g, ''));
                                if (!currentPrice) {
                                    currentPrice = price;
                                } else if (price > currentPrice) {
                                    originalPrice = price;
                                }
                            }
                        }
                    });
                    
                    // Extract discount percentage
                    // Look for SVG with discount badge and the percentage text
                    let discountPercentage = null;
                    const discountBadge = item.querySelector('svg ~ div.tw-text-050');
                    if (discountBadge) {
                        const discountText = discountBadge.textContent.trim();
                        const discountMatch = discountText.match(/(\d+)%/);
                        if (discountMatch) {
                            discountPercentage = parseInt(discountMatch[1]);
                        }
                    }
                    
                    // If no discount found but we have original price, calculate it
                    if (!discountPercentage && currentPrice && originalPrice && originalPrice > currentPrice) {
                        discountPercentage = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
                    }
                    
                    // Extract product URL (if available in a link)
                    let productUrl = null;
                    const linkElement = item.querySelector('a[href*="/prn/"]');
                    if (linkElement) {
                        productUrl = linkElement.href;
                    } else if (productId) {
                        // Try to construct URL from product ID if possible
                        // This might need adjustment based on actual URL structure
                        productUrl = `https://blinkit.com/prn/product/prid/${productId}`;
                    }
                    
                    // Extract delivery time if available
                    let deliveryTime = null;
                    const allText = item.innerText || item.textContent;
                    const deliveryMatch = allText.match(/(\d+\s*MINS?)/i);
                    if (deliveryMatch) {
                        deliveryTime = deliveryMatch[1];
                    }
                    
                    // Only add if we have at least a name or price
                    if (productName || currentPrice) {
                        productCards.push({
                            productId: productId || `product-${index}`,
                            productName,
                            productImage,
                            currentPrice,
                            originalPrice,
                            discountPercentage,
                            productWeight,
                            deliveryTime,
                            productUrl,
                            scrapedAt: new Date().toISOString()
                        });
                    }
                } catch (err) {
                    console.error(`Error processing product ${index}:`, err);
                }
            });
            
            // Fallback: If no products found with ID-based method, try alternative
            if (productCards.length === 0) {
                console.log('ID-based method found 0 products, trying fallback...');
                
                // Try finding by the container structure
                const alternativeItems = document.querySelectorAll('div[role="button"][tabindex="0"]');
                console.log(`Found ${alternativeItems.length} alternative product containers`);
                
                alternativeItems.forEach((item, index) => {
                    try {
                        // Check if this looks like a product card
                        const hasTitle = item.querySelector('div.tw-text-300.tw-font-semibold.tw-line-clamp-2');
                        const hasPrice = item.querySelector('div.tw-text-200.tw-font-semibold');
                        const hasAddButton = item.textContent.includes('ADD');
                        
                        if (hasTitle && hasPrice && hasAddButton) {
                            const productName = hasTitle.textContent.trim();
                            const priceText = hasPrice.textContent.trim();
                            const priceMatch = priceText.match(/₹\s*(\d+(?:,\d+)*(?:\.\d+)?)/);
                            const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : null;
                            
                            const img = item.querySelector('img');
                            const productImage = img ? (img.src || img.getAttribute('src')) : null;
                            
                            const weightEl = item.querySelector('div.tw-text-200.tw-font-medium.tw-line-clamp-1');
                            const productWeight = weightEl ? weightEl.textContent.trim() : null;
                            
                            productCards.push({
                                productId: item.id || `fallback-${index}`,
                                productName,
                                productImage,
                                currentPrice,
                                productWeight,
                                scrapedAt: new Date().toISOString()
                            });
                        }
                    } catch (err) {
                        console.error('Error in fallback extraction:', err);
                    }
                });
            }
            
            return productCards;
        });
        
        log.info(`✅ Extracted ${products.length} products from search results`);
        
        // Log sample product for debugging
        if (products.length > 0 && debugMode) {
            console.log('Sample product:', JSON.stringify(products[0], null, 2));
        }
        
        return products;
    } catch (error) {
        log.error(`Error extracting search products: ${error.message}`);
        return [];
    }
}

// Initialize the crawler
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
                '--disable-web-security'
            ]
        }
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.context().setGeolocation({ 
                latitude: 18.5204, 
                longitude: 73.8567 
            });
            
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            await page.setViewportSize({ width: 1920, height: 1080 });
            // Forward page console messages to Node console so debug logs are visible
            page.on('console', msg => {
                try {
                    const text = msg.text();
                    const type = msg.type();
                    console.log(`[page:${type}] ${text}`);
                } catch (e) {
                    // ignore
                }
            });
        }
    ],

    async requestHandler({ page, request, log }) {
        const { url } = request;

        log.info(`🔍 Processing search URL: ${url}`);

        try {
            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(5000);
            
            if (debugMode) {
                log.info('📸 Taking initial debug snapshot...');
                await debugPageState(page, log, 'search-initial');
            }
            
            // Close any popups
            try {
                const closeButtons = page.locator('button:has-text("Close"), button:has-text("×"), [aria-label="Close"]');
                const count = await closeButtons.count();
                if (count > 0) {
                    await closeButtons.first().click();
                    log.info('✓ Closed popup');
                    await page.waitForTimeout(1000);
                }
            } catch (e) {
                // No popup
            }
            
            // Wait for search results
            const resultsFound = await waitForSearchResults(page, log);
            
            if (!resultsFound) {
                log.warning('⚠️ No search results detected');
                if (debugMode) {
                    await debugPageState(page, log, 'no-results');
                }
            }
            
            // Scroll to load more products
            await autoScroll(page, log, scrollCount);
            
            if (debugMode) {
                await debugPageState(page, log, 'after-scroll');
            }
            
            // Extract products
            const products = await extractSearchProducts(page, log);
            
            if (products.length === 0) {
                log.error('❌ No products extracted! Check debug screenshots.');
                return;
            }
            
            // Extract search query from URL
            let searchQuery = null;
            const urlParams = new URL(url).searchParams;
            searchQuery = urlParams.get('q');
            
            // Save products
            let savedCount = 0;
            for (const product of products.slice(0, maxProductsPerSearch)) {
                product.searchQuery = searchQuery;
                product.searchUrl = url;
                
                await Dataset.pushData(product);
                savedCount++;
                log.info(`💾 Saved [${savedCount}/${Math.min(products.length, maxProductsPerSearch)}]: ${product.productName || product.productId}`);
            }
            
            log.info(`✅ Completed! Saved ${savedCount} products for query: "${searchQuery}"`);

        } catch (error) {
            log.error(`❌ Error processing ${url}: ${error.message}`);
            log.error(`Stack: ${error.stack}`);
            
            if (screenshotOnError) {
                try {
                    const screenshot = await page.screenshot({ fullPage: true });
                    await Actor.setValue(`error-screenshot-${Date.now()}.png`, screenshot, { contentType: 'image/png' });
                    log.info('📸 Error screenshot saved');
                } catch (e) {
                    log.error(`Failed to capture screenshot: ${e.message}`);
                }
            }
            
            throw error;
        }
    },

    failedRequestHandler: async ({ request, log }) => {
        log.error(`❌ Request ${request.url} failed`);
        
        const failedUrls = await Actor.getValue('FAILED_URLS') || [];
        failedUrls.push({
            url: request.url,
            timestamp: new Date().toISOString()
        });
        await Actor.setValue('FAILED_URLS', failedUrls);
    }
});

// Start the crawler
if (allSearchUrls.length > 0) {
    console.log('\n🚀 Starting Blinkit Search Results Scraper');
    console.log(`🔍 Search URLs: ${allSearchUrls.length}`);
    console.log(`📊 Max products per search: ${maxProductsPerSearch}`);
    console.log(`📜 Scroll iterations: ${scrollCount}`);
    console.log(`🐛 Debug mode: ${debugMode}`);
    console.log(`👁️  Headless: ${headless}\n`);
    
    allSearchUrls.forEach((url, idx) => {
        console.log(`  ${idx + 1}. ${url}`);
    });
    console.log('');
    
    await crawler.run(allSearchUrls.map(url => ({ url })));
    
    console.log('\n✅ Scraping completed!');
    console.log('📁 Results: storage/datasets/default/');
    console.log('📸 Screenshots: storage/key_value_stores/default/\n');
} else {
    console.log('❌ No search URLs or queries provided!');
    console.log('Please provide either "searchUrls" or "searchQueries" in input.json\n');
}

await Actor.exit();