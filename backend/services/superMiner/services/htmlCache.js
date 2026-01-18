/**
 * htmlCache.js - SuperMiner v3.1
 * 
 * Cache poisoning korumalı HTML cache.
 * 
 * KURALLAR:
 * - Blocked/partial HTML ASLA cache'lenmez
 * - TTL: 1 saat (3600 saniye)
 * - Max size: 2MB per entry
 * - Content signature ile poisoning detection
 */

const Redis = require('ioredis');
const crypto = require('crypto');

// Constants
const CACHE_TTL = 3600; // 1 hour
const MAX_CONTENT_SIZE = 2 * 1024 * 1024; // 2MB
const KEY_PREFIX = 'html_cache:';

// Block indicators - if HTML contains these, DON'T cache
const BLOCK_INDICATORS = [
    'cloudflare',
    'cf-error',
    'access denied',
    'forbidden',
    'security check',
    'captcha',
    'verify you are human',
    'please wait',
    'checking your browser',
    'ddos protection',
    'rate limit',
    'too many requests',
    'blocked',
    '403 error',
    '401 error',
    'unauthorized'
];

// Minimum content indicators - if HTML lacks these, it's likely partial
const CONTENT_INDICATORS = [
    '<html',
    '<body',
    '</html>',
    '</body>'
];

// Singleton
let instance = null;

class HtmlCache {
    constructor(redisUrl) {
        if (!redisUrl) {
            console.warn('[HtmlCache] ⚠️ REDIS_URL not provided, cache disabled');
            this.enabled = false;
            return;
        }
        
        this.enabled = true;
        this.redisUrl = redisUrl;
        this.redis = null;
        this.isConnected = false;
        
        // Stats
        this.stats = {
            hits: 0,
            misses: 0,
            poisonedRejected: 0,
            stored: 0
        };
        
        console.log('[HtmlCache] ✅ Initialized');
    }
    
    async connect() {
        if (!this.enabled) return false;
        if (this.isConnected && this.redis) return true;
        
        try {
            this.redis = new Redis(this.redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => {
                    if (times > 3) return null;
                    return Math.min(times * 200, 1000);
                },
                lazyConnect: true
            });
            
            await this.redis.connect();
            this.isConnected = true;
            console.log('[HtmlCache] ✅ Connected to Redis');
            return true;
            
        } catch (err) {
            console.error('[HtmlCache] ❌ Connection failed:', err.message);
            this.isConnected = false;
            return false;
        }
    }
    
    /**
     * Generate cache key from URL
     */
    generateKey(url) {
        const normalized = url.toLowerCase().trim().replace(/\/$/, '');
        const hash = crypto.createHash('md5').update(normalized).digest('hex');
        return KEY_PREFIX + hash;
    }
    
    /**
     * Generate content signature for poisoning detection
     */
    generateSignature(html) {
        // Use first 1000 chars + length + some structural elements
        const sample = html.substring(0, 1000);
        const structuralElements = [
            (html.match(/<table/gi) || []).length,
            (html.match(/<div/gi) || []).length,
            (html.match(/<a\s/gi) || []).length,
            (html.match(/@/g) || []).length // Email indicators
        ].join(':');
        
        return crypto.createHash('md5')
            .update(sample + html.length + structuralElements)
            .digest('hex');
    }
    
    /**
     * Check if HTML looks blocked/poisoned
     */
    isPoisoned(html) {
        if (!html || html.length < 500) {
            return { poisoned: true, reason: 'Content too short' };
        }
        
        const lowerHtml = html.toLowerCase();
        
        // Check for block indicators
        for (const indicator of BLOCK_INDICATORS) {
            if (lowerHtml.includes(indicator)) {
                return { poisoned: true, reason: `Contains block indicator: ${indicator}` };
            }
        }
        
        // Check for minimum content structure
        let hasStructure = false;
        for (const indicator of CONTENT_INDICATORS) {
            if (lowerHtml.includes(indicator)) {
                hasStructure = true;
                break;
            }
        }
        
        if (!hasStructure) {
            return { poisoned: true, reason: 'Missing HTML structure' };
        }
        
        // Check for very low content (likely empty/blocked page)
        const textContent = html.replace(/<[^>]*>/g, '').trim();
        if (textContent.length < 100) {
            return { poisoned: true, reason: 'Very low text content' };
        }
        
        return { poisoned: false, reason: null };
    }
    
    /**
     * Get cached HTML
     * @param {string} url 
     * @returns {Promise<{html: string, meta: Object}|null>}
     */
    async get(url) {
        if (!this.enabled) return null;
        if (!this.isConnected) await this.connect();
        if (!this.redis) return null;
        
        const key = this.generateKey(url);
        
        try {
            const cached = await this.redis.get(key);
            
            if (!cached) {
                this.stats.misses++;
                return null;
            }
            
            const data = JSON.parse(cached);
            
            // Verify not poisoned (double-check on retrieval)
            const poisonCheck = this.isPoisoned(data.html);
            if (poisonCheck.poisoned) {
                console.warn(`[HtmlCache] Poisoned cache detected for ${url}: ${poisonCheck.reason}`);
                this.stats.poisonedRejected++;
                
                // Delete poisoned entry
                await this.redis.del(key);
                return null;
            }
            
            this.stats.hits++;
            console.log(`[HtmlCache] HIT for ${url}`);
            
            return {
                html: data.html,
                meta: {
                    cachedAt: data.cachedAt,
                    signature: data.signature,
                    size: data.html.length,
                    fromCache: true
                }
            };
            
        } catch (err) {
            console.error(`[HtmlCache] Get error for ${url}:`, err.message);
            return null;
        }
    }
    
    /**
     * Store HTML in cache
     * @param {string} url 
     * @param {string} html 
     * @param {Object} options 
     * @returns {Promise<boolean>}
     */
    async set(url, html, options = {}) {
        if (!this.enabled) return false;
        if (!this.isConnected) await this.connect();
        if (!this.redis) return false;
        
        // Size check
        if (html.length > MAX_CONTENT_SIZE) {
            console.warn(`[HtmlCache] Content too large for ${url}: ${(html.length / 1024 / 1024).toFixed(2)}MB`);
            return false;
        }
        
        // Poison check - CRITICAL: Don't cache blocked content
        const poisonCheck = this.isPoisoned(html);
        if (poisonCheck.poisoned) {
            console.warn(`[HtmlCache] NOT caching poisoned content for ${url}: ${poisonCheck.reason}`);
            this.stats.poisonedRejected++;
            return false;
        }
        
        const key = this.generateKey(url);
        const signature = this.generateSignature(html);
        
        try {
            const data = JSON.stringify({
                html,
                signature,
                url,
                cachedAt: new Date().toISOString(),
                httpCode: options.httpCode || 200
            });
            
            const ttl = options.ttl || CACHE_TTL;
            await this.redis.setex(key, ttl, data);
            
            this.stats.stored++;
            console.log(`[HtmlCache] Stored ${url} (${(html.length / 1024).toFixed(1)}KB, TTL: ${ttl}s)`);
            
            return true;
            
        } catch (err) {
            console.error(`[HtmlCache] Set error for ${url}:`, err.message);
            return false;
        }
    }
    
    /**
     * Delete cached entry
     */
    async delete(url) {
        if (!this.enabled || !this.redis) return false;
        
        const key = this.generateKey(url);
        await this.redis.del(key);
        return true;
    }
    
    /**
     * Check if URL is cached
     */
    async has(url) {
        if (!this.enabled || !this.redis) return false;
        
        const key = this.generateKey(url);
        const exists = await this.redis.exists(key);
        return exists === 1;
    }
    
    /**
     * Get cache stats
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            ...this.stats,
            hitRate: total > 0 ? Math.round((this.stats.hits / total) * 100) : 0,
            total
        };
    }
    
    /**
     * Clear all cache (use with caution)
     */
    async clear() {
        if (!this.enabled || !this.redis) return false;
        
        const keys = await this.redis.keys(KEY_PREFIX + '*');
        if (keys.length > 0) {
            await this.redis.del(...keys);
        }
        
        console.log(`[HtmlCache] Cleared ${keys.length} entries`);
        return true;
    }
    
    async disconnect() {
        if (this.redis) {
            await this.redis.quit();
            this.isConnected = false;
        }
    }
}

function getHtmlCache() {
    if (!instance) {
        instance = new HtmlCache(process.env.REDIS_URL);
    }
    return instance;
}

module.exports = {
    HtmlCache,
    getHtmlCache,
    CACHE_TTL,
    MAX_CONTENT_SIZE,
    BLOCK_INDICATORS
};
