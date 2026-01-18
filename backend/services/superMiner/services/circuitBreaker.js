/**
 * circuitBreaker.js - SuperMiner v3.1
 * 
 * Domain-level failure tracking and blocking.
 * 
 * KURALLAR:
 * - 5 ardışık hata → domain blocked (30 dakika)
 * - Başarılı request → reset
 * - Half-open state: 1 test request izni
 */

// Circuit states
const CIRCUIT_STATE = {
    CLOSED: 'closed',       // Normal operation
    OPEN: 'open',           // Blocked, no requests allowed
    HALF_OPEN: 'half_open'  // Testing with single request
};

// Configuration
const CONFIG = {
    FAILURE_THRESHOLD: 5,           // Failures before opening circuit
    RECOVERY_TIMEOUT: 30 * 60 * 1000, // 30 minutes before half-open
    HALF_OPEN_MAX_REQUESTS: 1,      // Requests allowed in half-open
    SUCCESS_THRESHOLD: 2            // Successes needed to close from half-open
};

class CircuitBreaker {
    constructor() {
        // Domain tracking: domain -> CircuitState
        this.circuits = new Map();
        
        // Stats
        this.stats = {
            totalFailures: 0,
            totalSuccesses: 0,
            circuitsOpened: 0,
            circuitsClosed: 0
        };
        
        console.log('[CircuitBreaker] ✅ Initialized');
    }
    
    /**
     * Get or create circuit for domain
     */
    getCircuit(domain) {
        if (!this.circuits.has(domain)) {
            this.circuits.set(domain, {
                state: CIRCUIT_STATE.CLOSED,
                failures: 0,
                successes: 0,
                lastFailure: null,
                lastSuccess: null,
                openedAt: null,
                halfOpenRequests: 0,
                failureReasons: []
            });
        }
        return this.circuits.get(domain);
    }
    
    /**
     * Extract domain from URL
     */
    extractDomain(url) {
        try {
            return new URL(url).hostname;
        } catch {
            return url;
        }
    }
    
    /**
     * Check if request is allowed
     * @param {string} url 
     * @returns {{allowed: boolean, state: string, reason: string|null}}
     */
    canRequest(url) {
        const domain = this.extractDomain(url);
        const circuit = this.getCircuit(domain);
        
        switch (circuit.state) {
            case CIRCUIT_STATE.CLOSED:
                return { allowed: true, state: circuit.state, reason: null };
                
            case CIRCUIT_STATE.OPEN:
                // Check if recovery timeout passed
                if (this.shouldTransitionToHalfOpen(circuit)) {
                    circuit.state = CIRCUIT_STATE.HALF_OPEN;
                    circuit.halfOpenRequests = 0;
                    circuit.successes = 0;
                    console.log(`[CircuitBreaker] ${domain}: OPEN -> HALF_OPEN`);
                    return { allowed: true, state: circuit.state, reason: 'Testing after recovery timeout' };
                }
                return { 
                    allowed: false, 
                    state: circuit.state, 
                    reason: `Circuit open for ${domain}, retry after ${this.getTimeUntilHalfOpen(circuit)}ms` 
                };
                
            case CIRCUIT_STATE.HALF_OPEN:
                if (circuit.halfOpenRequests < CONFIG.HALF_OPEN_MAX_REQUESTS) {
                    circuit.halfOpenRequests++;
                    return { allowed: true, state: circuit.state, reason: 'Half-open test request' };
                }
                return { 
                    allowed: false, 
                    state: circuit.state, 
                    reason: 'Half-open request limit reached, waiting for result' 
                };
                
            default:
                return { allowed: true, state: 'unknown', reason: null };
        }
    }
    
    /**
     * Record a failure
     * @param {string} url 
     * @param {string} reason 
     */
    recordFailure(url, reason = 'unknown') {
        const domain = this.extractDomain(url);
        const circuit = this.getCircuit(domain);
        
        circuit.failures++;
        circuit.lastFailure = Date.now();
        circuit.failureReasons.push({
            reason,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 10 reasons
        if (circuit.failureReasons.length > 10) {
            circuit.failureReasons = circuit.failureReasons.slice(-10);
        }
        
        this.stats.totalFailures++;
        
        // State transitions
        if (circuit.state === CIRCUIT_STATE.HALF_OPEN) {
            // Failure in half-open -> back to open
            circuit.state = CIRCUIT_STATE.OPEN;
            circuit.openedAt = Date.now();
            console.log(`[CircuitBreaker] ${domain}: HALF_OPEN -> OPEN (failure: ${reason})`);
        } else if (circuit.state === CIRCUIT_STATE.CLOSED) {
            // Check threshold
            if (circuit.failures >= CONFIG.FAILURE_THRESHOLD) {
                circuit.state = CIRCUIT_STATE.OPEN;
                circuit.openedAt = Date.now();
                this.stats.circuitsOpened++;
                console.log(`[CircuitBreaker] ${domain}: CLOSED -> OPEN (${circuit.failures} failures)`);
            }
        }
    }
    
    /**
     * Record a success
     * @param {string} url 
     */
    recordSuccess(url) {
        const domain = this.extractDomain(url);
        const circuit = this.getCircuit(domain);
        
        circuit.successes++;
        circuit.lastSuccess = Date.now();
        
        this.stats.totalSuccesses++;
        
        // State transitions
        if (circuit.state === CIRCUIT_STATE.HALF_OPEN) {
            // Success in half-open
            if (circuit.successes >= CONFIG.SUCCESS_THRESHOLD) {
                // Enough successes -> close circuit
                circuit.state = CIRCUIT_STATE.CLOSED;
                circuit.failures = 0;
                circuit.failureReasons = [];
                this.stats.circuitsClosed++;
                console.log(`[CircuitBreaker] ${domain}: HALF_OPEN -> CLOSED (recovered)`);
            }
        } else if (circuit.state === CIRCUIT_STATE.CLOSED) {
            // Reset failure count on success
            circuit.failures = 0;
        }
    }
    
    /**
     * Check if should transition from OPEN to HALF_OPEN
     */
    shouldTransitionToHalfOpen(circuit) {
        if (circuit.state !== CIRCUIT_STATE.OPEN) return false;
        if (!circuit.openedAt) return true;
        
        const elapsed = Date.now() - circuit.openedAt;
        return elapsed >= CONFIG.RECOVERY_TIMEOUT;
    }
    
    /**
     * Get time until half-open
     */
    getTimeUntilHalfOpen(circuit) {
        if (!circuit.openedAt) return 0;
        const elapsed = Date.now() - circuit.openedAt;
        return Math.max(0, CONFIG.RECOVERY_TIMEOUT - elapsed);
    }
    
    /**
     * Check if domain is blocked
     */
    isBlocked(url) {
        const result = this.canRequest(url);
        return !result.allowed;
    }
    
    /**
     * Get circuit state for domain
     */
    getState(url) {
        const domain = this.extractDomain(url);
        const circuit = this.getCircuit(domain);
        
        return {
            domain,
            state: circuit.state,
            failures: circuit.failures,
            successes: circuit.successes,
            lastFailure: circuit.lastFailure,
            lastSuccess: circuit.lastSuccess,
            openedAt: circuit.openedAt,
            recentReasons: circuit.failureReasons.slice(-5)
        };
    }
    
    /**
     * Force reset a circuit (manual intervention)
     */
    reset(url) {
        const domain = this.extractDomain(url);
        this.circuits.delete(domain);
        console.log(`[CircuitBreaker] ${domain}: Manually reset`);
    }
    
    /**
     * Get all blocked domains
     */
    getBlockedDomains() {
        const blocked = [];
        
        for (const [domain, circuit] of this.circuits) {
            if (circuit.state === CIRCUIT_STATE.OPEN) {
                blocked.push({
                    domain,
                    failures: circuit.failures,
                    openedAt: circuit.openedAt,
                    timeUntilHalfOpen: this.getTimeUntilHalfOpen(circuit)
                });
            }
        }
        
        return blocked;
    }
    
    /**
     * Get stats
     */
    getStats() {
        return {
            ...this.stats,
            totalCircuits: this.circuits.size,
            openCircuits: this.getBlockedDomains().length,
            closedCircuits: Array.from(this.circuits.values()).filter(c => c.state === CIRCUIT_STATE.CLOSED).length,
            halfOpenCircuits: Array.from(this.circuits.values()).filter(c => c.state === CIRCUIT_STATE.HALF_OPEN).length
        };
    }
    
    /**
     * Cleanup old circuits (call periodically)
     */
    cleanup() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        let cleaned = 0;
        for (const [domain, circuit] of this.circuits) {
            const lastActivity = Math.max(circuit.lastFailure || 0, circuit.lastSuccess || 0);
            if (now - lastActivity > maxAge && circuit.state === CIRCUIT_STATE.CLOSED) {
                this.circuits.delete(domain);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            console.log(`[CircuitBreaker] Cleaned ${cleaned} inactive circuits`);
        }
    }
}

// Singleton
let instance = null;

function getCircuitBreaker() {
    if (!instance) {
        instance = new CircuitBreaker();
    }
    return instance;
}

module.exports = {
    CircuitBreaker,
    getCircuitBreaker,
    CIRCUIT_STATE,
    CONFIG
};
