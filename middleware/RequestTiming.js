/**
 * @fileoverview Request Timing Middleware for Performance Analysis
 * @description Provides detailed timing information for API requests to identify bottlenecks
 */

/**
 * Request timing middleware
 * Logs detailed timing information for each request stage
 */
export const requestTiming = (req, res, next) => {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substr(2, 8);
    
    // Store timing info on request object
    req.timing = {
        requestId,
        start: startTime,
        stages: {}
    };
    
    // Log request start
    console.log(`🔥 REQ-${requestId}: START ${req.method} ${req.originalUrl} at ${new Date().toISOString()}`);
    
    // Log middleware completion
    req.timing.middlewareComplete = Date.now();
    console.log(`🔧 REQ-${requestId}: MIDDLEWARE complete (${req.timing.middlewareComplete - startTime}ms)`);
    
    // Hook into response finish event
    res.on('finish', () => {
        const totalTime = Date.now() - startTime;
        const statusColor = res.statusCode >= 400 ? '🔴' : '✅';
        console.log(`${statusColor} REQ-${requestId}: COMPLETE ${res.statusCode} in ${totalTime}ms`);
    });
    
    next();
};

/**
 * Controller timing helper
 * Use this within controllers to log timing stages
 */
export const logTiming = (req, stage, additionalInfo = '') => {
    if (!req.timing) return;
    
    const now = Date.now();
    const sinceStart = now - req.timing.start;
    const sinceLast = req.timing.lastStage ? now - req.timing.lastStage : 0;
    
    req.timing.stages[stage] = now;
    req.timing.lastStage = now;
    
    const info = additionalInfo ? ` - ${additionalInfo}` : '';
    console.log(`⏱️  REQ-${req.timing.requestId}: ${stage.toUpperCase()} at ${sinceStart}ms (+${sinceLast}ms)${info}`);
};
