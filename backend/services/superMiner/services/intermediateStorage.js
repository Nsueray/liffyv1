/**
 * intermediateStorage.js - SuperMiner v3.1
 * 
 * Flow 1 → Flow 2 veri aktarımı için Redis TTL storage.
 * DB'ye yazmadan gecici depolama: temp_results:{jobId}
 * 
 * KURALLAR:
 * - TTL 10 dakika (600 saniye)
 * - Flow 1 sonuclari DB'ye YAZILMAZ, Redis'e kaydedilir
 * - Flow 2 bu veriyi alir, kendi sonuclariyla birlestirir
 * - Final merge sonrasi tek seferde DB'ye yazilir
 * - Large payload warning (200MB Redis Starter plan)
 */

const Redis = require('ioredis');

// Constants
const TEMP_RESULTS_TTL = 600; // 10 dakika
const PAYLOAD_WARN_SIZE = 100 * 1024 * 1024; // 100MB - log warning
const KEY_PREFIX = 'temp_results:';
const LOCK_PREFIX = 'lock:';
const LOCK_TTL = 30; // 30 saniye lock

// Singleton instance
let instance = null;

class IntermediateStorage {
    constructor(redisUrl) {
        if (!redisUrl) {
            console.warn('[IntermediateStorage] ⚠️ REDIS_URL not provided, storage disabled');
            this.enabled = false;
            return;
        }
        
        this.enabled = true;
        this.redisUrl = redisUrl;
        this.redis = null;
        this.isConnected = false;
        
        console.log('[IntermediateStorage] ✅ Initialized');
    }
    
    /**
     * Connect to Redis
     */
    async connect() {
        if (!this.enabled) {
            return false;
        }
        
        if (this.isConnected && this.redis) {
            return true;
        }
        
        try {
            this.redis = new Redis(this.redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => {
                    if (times > 5) return null;
                    return Math.min(times * 200, 2000);
                },
                lazyConnect: true
            });
            
            await this.redis.connect();
            
            this.redis.on('error', (err) => {
                console.error('[IntermediateStorage] Redis error:', err.message);
            });
            
            this.isConnected = true;
            console.log('[IntermediateStorage] ✅ Connected to Redis');
            
            return true;
            
        } catch (err) {
            console.error('[IntermediateStorage] ❌ Connection failed:', err.message);
            this.isConnected = false;
            return false;
        }
    }
    
    /**
     * Save Flow 1 results to Redis (NOT to DB!)
     * @param {string} jobId - Mining job ID
     * @param {Object} results - Flow 1 results
     * @returns {string|null} Redis key or null on failure
     */
    async saveFlowResults(jobId, results) {
        if (!this.enabled) {
            console.warn('[IntermediateStorage] Disabled, cannot save');
            return null;
        }
        
        if (!this.isConnected) {
            await this.connect();
        }
        
        if (!this.redis) {
            console.error('[IntermediateStorage] Redis not available');
            return null;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            const data = JSON.stringify({
                contacts: results.contacts || [],
                minerStats: results.minerStats || {},
                websiteUrls: results.websiteUrls || [],
                savedAt: new Date().toISOString(),
                flowVersion: 1
            });
            
            // Payload size warning (Redis Starter plan = 256MB)
            if (data.length > PAYLOAD_WARN_SIZE) {
                console.warn(`[IntermediateStorage] ⚠️ Large payload: ${(data.length / 1024 / 1024).toFixed(2)}MB for job: ${jobId}`);
            }

            await this.redis.setex(key, TEMP_RESULTS_TTL, data);
            
            console.log(`[IntermediateStorage] 💾 Saved Flow 1 results for job: ${jobId} (${results.contacts?.length || 0} contacts)`);
            
            return key;
            
        } catch (err) {
            console.error(`[IntermediateStorage] Save error for ${jobId}:`, err.message);
            return null;
        }
    }
    
    /**
     * Get Flow 1 results (for Flow 2 to merge)
     * @param {string} jobId - Mining job ID
     * @returns {Object|null} Flow 1 results or null
     */
    async getFlowResults(jobId) {
        if (!this.enabled) {
            console.warn('[IntermediateStorage] Disabled, cannot get');
            return null;
        }
        
        if (!this.isConnected) {
            await this.connect();
        }
        
        if (!this.redis) {
            console.error('[IntermediateStorage] Redis not available');
            return null;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            const data = await this.redis.get(key);
            
            if (!data) {
                console.warn(`[IntermediateStorage] No temp results found for: ${jobId}`);
                return null;
            }
            
            const parsed = JSON.parse(data);
            
            console.log(`[IntermediateStorage] 📤 Retrieved Flow 1 results for job: ${jobId} (${parsed.contacts?.length || 0} contacts)`);
            
            return parsed;
            
        } catch (err) {
            console.error(`[IntermediateStorage] Get error for ${jobId}:`, err.message);
            return null;
        }
    }
    
    /**
     * Clear temp results after final DB write
     * @param {string} jobId - Mining job ID
     */
    async clearFlowResults(jobId) {
        if (!this.enabled || !this.redis) {
            return false;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            await this.redis.del(key);
            console.log(`[IntermediateStorage] 🗑️ Cleared temp results for job: ${jobId}`);
            return true;
        } catch (err) {
            console.error(`[IntermediateStorage] Clear error for ${jobId}:`, err.message);
            return false;
        }
    }
    
    /**
     * Check if Flow 1 results exist
     * @param {string} jobId - Mining job ID
     * @returns {boolean}
     */
    async hasFlowResults(jobId) {
        if (!this.enabled || !this.redis) {
            return false;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            const exists = await this.redis.exists(key);
            return exists === 1;
        } catch (err) {
            return false;
        }
    }
    
    /**
     * Get TTL remaining for job results
     * @param {string} jobId - Mining job ID
     * @returns {number} TTL in seconds, -1 if not exists
     */
    async getTTL(jobId) {
        if (!this.enabled || !this.redis) {
            return -1;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            return await this.redis.ttl(key);
        } catch (err) {
            return -1;
        }
    }
    
    /**
     * Extend TTL (if Flow 2 is taking long)
     * @param {string} jobId - Mining job ID
     * @param {number} additionalSeconds - Additional TTL
     */
    async extendTTL(jobId, additionalSeconds = 300) {
        if (!this.enabled || !this.redis) {
            return false;
        }
        
        const key = KEY_PREFIX + jobId;
        
        try {
            const currentTTL = await this.redis.ttl(key);
            if (currentTTL > 0) {
                await this.redis.expire(key, currentTTL + additionalSeconds);
                console.log(`[IntermediateStorage] Extended TTL for ${jobId} by ${additionalSeconds}s`);
                return true;
            }
            return false;
        } catch (err) {
            console.error(`[IntermediateStorage] ExtendTTL error for ${jobId}:`, err.message);
            return false;
        }
    }
    
    /**
     * Acquire distributed lock (for concurrent safety)
     * @param {string} jobId - Mining job ID
     * @returns {boolean} true if lock acquired
     */
    async acquireLock(jobId) {
        if (!this.enabled || !this.redis) {
            return true; // Allow if Redis disabled
        }
        
        const lockKey = LOCK_PREFIX + jobId;
        
        try {
            // SET NX = only if not exists
            const result = await this.redis.set(lockKey, Date.now(), 'EX', LOCK_TTL, 'NX');
            return result === 'OK';
        } catch (err) {
            console.error(`[IntermediateStorage] AcquireLock error for ${jobId}:`, err.message);
            return false;
        }
    }
    
    /**
     * Release distributed lock
     * @param {string} jobId - Mining job ID
     */
    async releaseLock(jobId) {
        if (!this.enabled || !this.redis) {
            return;
        }
        
        const lockKey = LOCK_PREFIX + jobId;
        
        try {
            await this.redis.del(lockKey);
        } catch (err) {
            // Ignore lock release errors
        }
    }
    
    /**
     * Graceful disconnect
     */
    async disconnect() {
        if (!this.enabled || !this.redis) {
            return;
        }
        
        try {
            await this.redis.quit();
            this.isConnected = false;
            console.log('[IntermediateStorage] ✅ Disconnected');
        } catch (err) {
            console.error('[IntermediateStorage] Disconnect error:', err.message);
        }
    }
    
    /**
     * Health check
     */
    async healthCheck() {
        if (!this.enabled) {
            return { status: 'disabled', message: 'REDIS_URL not configured' };
        }
        
        if (!this.isConnected || !this.redis) {
            return { status: 'disconnected', message: 'Not connected to Redis' };
        }
        
        try {
            await this.redis.ping();
            
            // Count temp keys
            const keys = await this.redis.keys(KEY_PREFIX + '*');
            
            return {
                status: 'healthy',
                tempResultsCount: keys.length,
                ttlDefault: TEMP_RESULTS_TTL,
                maxPayloadMB: MAX_PAYLOAD_SIZE / 1024 / 1024
            };
        } catch (err) {
            return { status: 'unhealthy', message: err.message };
        }
    }
}

/**
 * Get singleton instance
 */
function getIntermediateStorage() {
    if (!instance) {
        const redisUrl = process.env.REDIS_URL;
        instance = new IntermediateStorage(redisUrl);
    }
    return instance;
}

module.exports = {
    IntermediateStorage,
    getIntermediateStorage,
    TEMP_RESULTS_TTL,
    MAX_PAYLOAD_SIZE,
    KEY_PREFIX
};
