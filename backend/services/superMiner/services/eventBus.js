/**
 * eventBus.js - SuperMiner v3.1
 * 
 * Redis Pub/Sub wrapper for distributed event system.
 * Local EventEmitter KULLANILMAZ - sadece Redis.
 * 
 * KURALLAR:
 * - Ayri publisher ve subscriber connection (Redis kurali)
 * - Tüm event'ler JSON serialize edilir
 * - Graceful shutdown destegi
 * - Connection retry logic
 */

const Redis = require('ioredis');

// Event channels
const CHANNELS = {
    AGGREGATION_DONE: 'mining:aggregation:done',
    FLOW2_START: 'mining:flow2:start',
    FLOW2_DONE: 'mining:flow2:done',
    JOB_COMPLETED: 'mining:job:completed',
    JOB_FAILED: 'mining:job:failed',
    COST_LIMIT_REACHED: 'mining:cost:limit'
};

// Singleton instance
let instance = null;

class EventBus {
    constructor(redisUrl) {
        if (!redisUrl) {
            console.warn('[EventBus] ⚠️ REDIS_URL not provided, EventBus disabled');
            this.enabled = false;
            return;
        }
        
        this.enabled = true;
        this.redisUrl = redisUrl;
        this.handlers = new Map();
        this.processedEvents = new Set(); // Idempotency tracking
        this.processedEventsTTL = 10 * 60 * 1000; // 10 minutes
        
        // Ayri publisher ve subscriber connection (Redis kurali)
        this.publisher = null;
        this.subscriber = null;
        this.isConnected = false;
        this.isListening = false;
        
        console.log('[EventBus] ✅ Initialized (Redis mode)');
    }
    
    /**
     * Connect to Redis
     */
    async connect() {
        if (!this.enabled) {
            console.warn('[EventBus] Disabled, skipping connect');
            return false;
        }
        
        if (this.isConnected) {
            return true;
        }
        
        try {
            // Publisher connection
            this.publisher = new Redis(this.redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => {
                    if (times > 5) return null;
                    return Math.min(times * 200, 2000);
                },
                lazyConnect: true
            });
            
            // Subscriber connection (ayri olmali)
            this.subscriber = new Redis(this.redisUrl, {
                maxRetriesPerRequest: 3,
                retryStrategy: (times) => {
                    if (times > 5) return null;
                    return Math.min(times * 200, 2000);
                },
                lazyConnect: true
            });
            
            // Connect both
            await this.publisher.connect();
            await this.subscriber.connect();
            
            // Event handlers
            this.publisher.on('error', (err) => {
                console.error('[EventBus] Publisher error:', err.message);
            });
            
            this.subscriber.on('error', (err) => {
                console.error('[EventBus] Subscriber error:', err.message);
            });
            
            this.isConnected = true;
            console.log('[EventBus] ✅ Connected to Redis');
            
            return true;
            
        } catch (err) {
            console.error('[EventBus] ❌ Connection failed:', err.message);
            this.isConnected = false;
            return false;
        }
    }
    
    /**
     * Publish event to channel
     * @param {string} channel - Channel name (use CHANNELS constants)
     * @param {Object} data - Event data
     */
    async publish(channel, data) {
        if (!this.enabled) {
            console.warn('[EventBus] Disabled, skipping publish');
            return false;
        }
        
        if (!this.isConnected) {
            await this.connect();
        }
        
        if (!this.publisher) {
            console.error('[EventBus] Publisher not available');
            return false;
        }
        
        try {
            const message = JSON.stringify({
                ...data,
                _eventId: `${channel}:${data.jobId || 'unknown'}:${Date.now()}`,
                _timestamp: new Date().toISOString(),
                _sourceWorker: process.env.WORKER_ID || process.env.HOSTNAME || 'unknown'
            });
            
            await this.publisher.publish(channel, message);
            
            console.log(`[EventBus] 📤 Published to ${channel}:`, {
                jobId: data.jobId,
                timestamp: new Date().toISOString()
            });
            
            return true;
            
        } catch (err) {
            console.error(`[EventBus] Publish error on ${channel}:`, err.message);
            return false;
        }
    }
    
    /**
     * Subscribe to channel
     * @param {string} channel - Channel name
     * @param {Function} handler - Async handler function
     */
    subscribe(channel, handler) {
        if (!this.enabled) {
            console.warn('[EventBus] Disabled, skipping subscribe');
            return false;
        }
        
        if (!this.handlers.has(channel)) {
            this.handlers.set(channel, []);
        }
        
        this.handlers.get(channel).push(handler);
        console.log(`[EventBus] 📥 Subscribed to ${channel}`);
        
        return true;
    }
    
    /**
     * Start listening for events
     * Call this ONCE after all subscriptions
     */
    async startListening() {
        if (!this.enabled) {
            console.warn('[EventBus] Disabled, skipping startListening');
            return false;
        }
        
        if (this.isListening) {
            console.warn('[EventBus] Already listening');
            return true;
        }
        
        if (!this.isConnected) {
            await this.connect();
        }
        
        if (!this.subscriber) {
            console.error('[EventBus] Subscriber not available');
            return false;
        }
        
        try {
            // Subscribe to all registered channels
            const channels = Array.from(this.handlers.keys());
            
            if (channels.length === 0) {
                console.warn('[EventBus] No channels to subscribe');
                return false;
            }
            
            for (const channel of channels) {
                await this.subscriber.subscribe(channel);
            }
            
            // Message handler
            this.subscriber.on('message', async (channel, message) => {
                await this._handleMessage(channel, message);
            });
            
            this.isListening = true;
            console.log(`[EventBus] ✅ Listening on ${channels.length} channels:`, channels);
            
            return true;
            
        } catch (err) {
            console.error('[EventBus] startListening error:', err.message);
            return false;
        }
    }
    
    /**
     * Internal message handler with idempotency
     */
    async _handleMessage(channel, message) {
        let data;
        
        try {
            data = JSON.parse(message);
        } catch (err) {
            console.error(`[EventBus] Invalid JSON on ${channel}:`, message);
            return;
        }
        
        const eventId = data._eventId;
        
        // Idempotency check
        if (eventId && this.processedEvents.has(eventId)) {
            console.log(`[EventBus] ⏭️ Skipping duplicate event: ${eventId}`);
            return;
        }
        
        // Mark as processed
        if (eventId) {
            this.processedEvents.add(eventId);
            
            // Auto-cleanup after TTL
            setTimeout(() => {
                this.processedEvents.delete(eventId);
            }, this.processedEventsTTL);
        }
        
        // Get handlers
        const handlers = this.handlers.get(channel) || [];
        
        if (handlers.length === 0) {
            console.warn(`[EventBus] No handlers for ${channel}`);
            return;
        }
        
        console.log(`[EventBus] 📨 Received on ${channel}:`, {
            jobId: data.jobId,
            eventId: eventId
        });
        
        // Execute all handlers
        for (const handler of handlers) {
            try {
                await handler(data);
            } catch (err) {
                console.error(`[EventBus] Handler error on ${channel}:`, err.message);
            }
        }
    }
    
    /**
     * Check if event was already processed (for external idempotency check)
     */
    wasProcessed(jobId, channel) {
        const pattern = `${channel}:${jobId}:`;
        for (const eventId of this.processedEvents) {
            if (eventId.startsWith(pattern)) {
                return true;
            }
        }
        return false;
    }
    
    /**
     * Graceful shutdown
     */
    async disconnect() {
        if (!this.enabled) return;
        
        console.log('[EventBus] Disconnecting...');
        
        try {
            if (this.subscriber) {
                await this.subscriber.unsubscribe();
                await this.subscriber.quit();
            }
            
            if (this.publisher) {
                await this.publisher.quit();
            }
            
            this.isConnected = false;
            this.isListening = false;
            
            console.log('[EventBus] ✅ Disconnected');
            
        } catch (err) {
            console.error('[EventBus] Disconnect error:', err.message);
        }
    }
    
    /**
     * Health check
     */
    async healthCheck() {
        if (!this.enabled) {
            return { status: 'disabled', message: 'REDIS_URL not configured' };
        }
        
        if (!this.isConnected) {
            return { status: 'disconnected', message: 'Not connected to Redis' };
        }
        
        try {
            await this.publisher.ping();
            return { 
                status: 'healthy', 
                listening: this.isListening,
                channels: Array.from(this.handlers.keys()),
                processedEventsCount: this.processedEvents.size
            };
        } catch (err) {
            return { status: 'unhealthy', message: err.message };
        }
    }
}

/**
 * Get singleton instance
 */
function getEventBus() {
    if (!instance) {
        const redisUrl = process.env.REDIS_URL;
        instance = new EventBus(redisUrl);
    }
    return instance;
}

/**
 * Helper: Publish aggregation done event
 */
async function publishAggregationDone(jobId, enrichmentRate, contactCount, websiteUrls = [], deepCrawlAttempted = false) {
    const eventBus = getEventBus();
    return eventBus.publish(CHANNELS.AGGREGATION_DONE, {
        jobId,
        enrichmentRate,
        contactCount,
        websiteUrls,
        deepCrawlAttempted
    });
}

/**
 * Helper: Publish job completed event
 */
async function publishJobCompleted(jobId, totalContacts, totalEmails, stats = {}) {
    const eventBus = getEventBus();
    return eventBus.publish(CHANNELS.JOB_COMPLETED, {
        jobId,
        totalContacts,
        totalEmails,
        stats
    });
}

/**
 * Helper: Publish job failed event
 */
async function publishJobFailed(jobId, error, lastStatus = null) {
    const eventBus = getEventBus();
    return eventBus.publish(CHANNELS.JOB_FAILED, {
        jobId,
        error: error.message || error,
        lastStatus
    });
}

module.exports = {
    EventBus,
    getEventBus,
    CHANNELS,
    publishAggregationDone,
    publishJobCompleted,
    publishJobFailed
};
