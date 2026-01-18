/**
 * costTracker.js - SuperMiner v3.1
 * 
 * URL-level and job-level cost tracking.
 * 
 * KURALLAR:
 * - Per URL: $0.10 max, 3 retry max
 * - Per Job: $2.00 max
 * - Per Tenant: $50/month
 * - Circuit breaker for expensive domains
 */

const { getEventBus, CHANNELS } = require('./eventBus');

// ============================================
// COST LIMITS
// ============================================

const COST_LIMITS = {
    PER_URL: 0.10,          // $0.10 max per URL
    PER_JOB: 2.00,          // $2.00 max per job
    PER_TENANT_MONTHLY: 50, // $50/month per tenant
    MAX_RETRIES_PER_URL: 3  // Max retry attempts
};

// Estimated costs per operation
const OPERATION_COSTS = {
    AI_EXTRACTION: 0.01,      // ~$0.01 per AI call
    PLAYWRIGHT_PAGE: 0.001,   // Minimal compute cost
    HTTP_REQUEST: 0.0001,     // Negligible
    DEEP_CRAWL_PAGE: 0.005    // Website scraper per page
};

// ============================================
// COST TRACKER CLASS
// ============================================

class CostTracker {
    constructor() {
        // Job-level tracking: jobId -> { totalCost, urlCosts, retries }
        this.jobCosts = new Map();
        
        // Tenant-level tracking: tenantId -> { monthlyCost, lastReset }
        this.tenantCosts = new Map();
        
        // URL-level tracking: url -> { cost, retries, lastAttempt }
        this.urlTracking = new Map();
        
        // Circuit breaker: domain -> { failures, lastFailure, blocked }
        this.circuitBreaker = new Map();
        
        console.log('[CostTracker] ✅ Initialized');
    }
    
    /**
     * Initialize tracking for a job
     * @param {string} jobId 
     * @param {string} tenantId 
     */
    initJob(jobId, tenantId) {
        this.jobCosts.set(jobId, {
            tenantId,
            totalCost: 0,
            urlCosts: new Map(),
            operations: [],
            startedAt: new Date().toISOString()
        });
        
        // Ensure tenant tracking exists
        if (!this.tenantCosts.has(tenantId)) {
            this.tenantCosts.set(tenantId, {
                monthlyCost: 0,
                lastReset: new Date().toISOString(),
                jobCount: 0
            });
        }
        
        const tenant = this.tenantCosts.get(tenantId);
        tenant.jobCount++;
        
        console.log(`[CostTracker] Job ${jobId} initialized for tenant ${tenantId}`);
    }
    
    /**
     * Record a cost for an operation
     * @param {string} jobId 
     * @param {string} operation - Operation type from OPERATION_COSTS
     * @param {string} url - URL being processed (optional)
     * @param {number} customCost - Override cost (optional)
     * @returns {{allowed: boolean, reason: string|null}}
     */
    recordCost(jobId, operation, url = null, customCost = null) {
        const job = this.jobCosts.get(jobId);
        if (!job) {
            console.warn(`[CostTracker] Job ${jobId} not initialized`);
            return { allowed: true, reason: null };
        }
        
        const cost = customCost !== null ? customCost : (OPERATION_COSTS[operation] || 0);
        
        // Check job limit
        if (job.totalCost + cost > COST_LIMITS.PER_JOB) {
            console.warn(`[CostTracker] Job ${jobId} exceeded job limit ($${COST_LIMITS.PER_JOB})`);
            return { 
                allowed: false, 
                reason: `Job cost limit exceeded ($${job.totalCost.toFixed(3)}/$${COST_LIMITS.PER_JOB})` 
            };
        }
        
        // Check URL limit if URL provided
        if (url) {
            const urlKey = this.normalizeUrl(url);
            let urlCost = job.urlCosts.get(urlKey) || 0;
            
            if (urlCost + cost > COST_LIMITS.PER_URL) {
                console.warn(`[CostTracker] URL ${urlKey} exceeded URL limit ($${COST_LIMITS.PER_URL})`);
                return { 
                    allowed: false, 
                    reason: `URL cost limit exceeded ($${urlCost.toFixed(3)}/$${COST_LIMITS.PER_URL})` 
                };
            }
            
            job.urlCosts.set(urlKey, urlCost + cost);
        }
        
        // Check tenant limit
        const tenant = this.tenantCosts.get(job.tenantId);
        if (tenant) {
            // Reset monthly if needed
            this.checkMonthlyReset(tenant);
            
            if (tenant.monthlyCost + cost > COST_LIMITS.PER_TENANT_MONTHLY) {
                console.warn(`[CostTracker] Tenant ${job.tenantId} exceeded monthly limit`);
                return { 
                    allowed: false, 
                    reason: `Monthly tenant limit exceeded ($${tenant.monthlyCost.toFixed(2)}/$${COST_LIMITS.PER_TENANT_MONTHLY})` 
                };
            }
            
            tenant.monthlyCost += cost;
        }
        
        // Record the cost
        job.totalCost += cost;
        job.operations.push({
            operation,
            url,
            cost,
            timestamp: new Date().toISOString()
        });
        
        return { allowed: true, reason: null };
    }
    
    /**
     * Check and record a retry attempt
     * @param {string} jobId 
     * @param {string} url 
     * @returns {{allowed: boolean, retryCount: number, reason: string|null}}
     */
    recordRetry(jobId, url) {
        const urlKey = this.normalizeUrl(url);
        
        let tracking = this.urlTracking.get(urlKey);
        if (!tracking) {
            tracking = { retries: 0, lastAttempt: null };
            this.urlTracking.set(urlKey, tracking);
        }
        
        tracking.retries++;
        tracking.lastAttempt = new Date().toISOString();
        
        if (tracking.retries > COST_LIMITS.MAX_RETRIES_PER_URL) {
            console.warn(`[CostTracker] URL ${urlKey} exceeded retry limit`);
            return { 
                allowed: false, 
                retryCount: tracking.retries,
                reason: `Max retries exceeded (${tracking.retries}/${COST_LIMITS.MAX_RETRIES_PER_URL})` 
            };
        }
        
        return { allowed: true, retryCount: tracking.retries, reason: null };
    }
    
    /**
     * Check if operation is allowed (pre-check)
     * @param {string} jobId 
     * @param {string} operation 
     * @param {string} url 
     * @returns {{allowed: boolean, reason: string|null}}
     */
    canProceed(jobId, operation, url = null) {
        const job = this.jobCosts.get(jobId);
        if (!job) {
            return { allowed: true, reason: null };
        }
        
        const cost = OPERATION_COSTS[operation] || 0;
        
        // Check job limit
        if (job.totalCost + cost > COST_LIMITS.PER_JOB) {
            return { allowed: false, reason: 'Job cost limit would be exceeded' };
        }
        
        // Check URL limit
        if (url) {
            const urlKey = this.normalizeUrl(url);
            const urlCost = job.urlCosts.get(urlKey) || 0;
            
            if (urlCost + cost > COST_LIMITS.PER_URL) {
                return { allowed: false, reason: 'URL cost limit would be exceeded' };
            }
            
            // Check circuit breaker
            const domain = this.extractDomain(url);
            const breaker = this.circuitBreaker.get(domain);
            if (breaker && breaker.blocked) {
                return { allowed: false, reason: `Domain ${domain} is circuit-broken` };
            }
        }
        
        // Check tenant limit
        const tenant = this.tenantCosts.get(job.tenantId);
        if (tenant && tenant.monthlyCost + cost > COST_LIMITS.PER_TENANT_MONTHLY) {
            return { allowed: false, reason: 'Tenant monthly limit would be exceeded' };
        }
        
        return { allowed: true, reason: null };
    }
    
    // ============================================
    // CIRCUIT BREAKER
    // ============================================
    
    /**
     * Record a failure for circuit breaker
     * @param {string} url 
     * @param {string} reason 
     */
    recordFailure(url, reason = 'unknown') {
        const domain = this.extractDomain(url);
        
        let breaker = this.circuitBreaker.get(domain);
        if (!breaker) {
            breaker = { failures: 0, lastFailure: null, blocked: false, reasons: [] };
            this.circuitBreaker.set(domain, breaker);
        }
        
        breaker.failures++;
        breaker.lastFailure = new Date().toISOString();
        breaker.reasons.push(reason);
        
        // Block after 5 consecutive failures
        if (breaker.failures >= 5) {
            breaker.blocked = true;
            console.warn(`[CostTracker] Circuit breaker OPEN for domain: ${domain}`);
            
            // Publish event
            const eventBus = getEventBus();
            if (eventBus) {
                eventBus.publish(CHANNELS.COST_LIMIT_REACHED, {
                    type: 'circuit_breaker',
                    domain,
                    failures: breaker.failures,
                    reason: 'Too many failures'
                });
            }
        }
    }
    
    /**
     * Record a success (reset failure count)
     * @param {string} url 
     */
    recordSuccess(url) {
        const domain = this.extractDomain(url);
        const breaker = this.circuitBreaker.get(domain);
        
        if (breaker) {
            breaker.failures = 0;
            breaker.blocked = false;
            breaker.reasons = [];
        }
    }
    
    /**
     * Check if domain is blocked
     * @param {string} url 
     * @returns {boolean}
     */
    isDomainBlocked(url) {
        const domain = this.extractDomain(url);
        const breaker = this.circuitBreaker.get(domain);
        return breaker ? breaker.blocked : false;
    }
    
    // ============================================
    // REPORTING
    // ============================================
    
    /**
     * Get job cost summary
     * @param {string} jobId 
     * @returns {Object}
     */
    getJobSummary(jobId) {
        const job = this.jobCosts.get(jobId);
        if (!job) {
            return null;
        }
        
        return {
            jobId,
            tenantId: job.tenantId,
            totalCost: job.totalCost,
            urlCount: job.urlCosts.size,
            operationCount: job.operations.length,
            startedAt: job.startedAt,
            costBreakdown: this.getCostBreakdown(job.operations),
            topUrls: this.getTopUrls(job.urlCosts, 5)
        };
    }
    
    /**
     * Get tenant cost summary
     * @param {string} tenantId 
     * @returns {Object}
     */
    getTenantSummary(tenantId) {
        const tenant = this.tenantCosts.get(tenantId);
        if (!tenant) {
            return null;
        }
        
        return {
            tenantId,
            monthlyCost: tenant.monthlyCost,
            monthlyLimit: COST_LIMITS.PER_TENANT_MONTHLY,
            usagePercent: Math.round((tenant.monthlyCost / COST_LIMITS.PER_TENANT_MONTHLY) * 100),
            jobCount: tenant.jobCount,
            lastReset: tenant.lastReset
        };
    }
    
    /**
     * Finalize job and return final stats
     * @param {string} jobId 
     * @returns {Object}
     */
    finalizeJob(jobId) {
        const summary = this.getJobSummary(jobId);
        
        // Clean up job tracking (keep tenant tracking)
        this.jobCosts.delete(jobId);
        
        console.log(`[CostTracker] Job ${jobId} finalized: $${summary?.totalCost.toFixed(4) || 0}`);
        
        return summary;
    }
    
    // ============================================
    // HELPERS
    // ============================================
    
    normalizeUrl(url) {
        try {
            const u = new URL(url);
            return `${u.hostname}${u.pathname}`;
        } catch {
            return url;
        }
    }
    
    extractDomain(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }
    
    checkMonthlyReset(tenant) {
        const lastReset = new Date(tenant.lastReset);
        const now = new Date();
        
        // Reset if different month
        if (lastReset.getMonth() !== now.getMonth() || 
            lastReset.getFullYear() !== now.getFullYear()) {
            tenant.monthlyCost = 0;
            tenant.lastReset = now.toISOString();
            tenant.jobCount = 0;
            console.log('[CostTracker] Monthly reset performed');
        }
    }
    
    getCostBreakdown(operations) {
        const breakdown = {};
        for (const op of operations) {
            breakdown[op.operation] = (breakdown[op.operation] || 0) + op.cost;
        }
        return breakdown;
    }
    
    getTopUrls(urlCosts, limit) {
        return Array.from(urlCosts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([url, cost]) => ({ url, cost }));
    }
    
    /**
     * Get global stats
     * @returns {Object}
     */
    getGlobalStats() {
        return {
            activeJobs: this.jobCosts.size,
            trackedTenants: this.tenantCosts.size,
            trackedUrls: this.urlTracking.size,
            blockedDomains: Array.from(this.circuitBreaker.entries())
                .filter(([_, b]) => b.blocked)
                .map(([domain, _]) => domain)
        };
    }
}

// Singleton instance
let instance = null;

function getCostTracker() {
    if (!instance) {
        instance = new CostTracker();
    }
    return instance;
}

module.exports = {
    CostTracker,
    getCostTracker,
    COST_LIMITS,
    OPERATION_COSTS
};
