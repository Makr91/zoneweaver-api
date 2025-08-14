import config from '../config/ConfigLoader.js';
import { Op } from 'sequelize';

class CleanupService {
    constructor() {
        this.cleanupConfig = config.get('cleanup') || { interval: 300, retention_days: 7 };
        this.tasks = [];
        this.isRunning = false; // Mutex protection
        this.stats = {
            totalRuns: 0,
            lastRunTime: null,
            lastRunDuration: null,
            totalTasksProcessed: 0,
            totalErrors: 0,
            lastError: null
        };
    }

    /**
     * Register a cleanup task
     * @param {Object} task - Task configuration
     * @param {string} task.name - Task name for logging
     * @param {Function|Object} task.handler - Function to execute or {model, where} for model-based cleanup
     * @param {string} [task.description] - Optional task description
     */
    registerTask(task) {
        if (!task.name) {
            throw new Error('Task must have a name');
        }
        
        if (!task.handler && !task.model) {
            throw new Error('Task must have either a handler function or model');
        }
        
        this.tasks.push({
            name: task.name,
            handler: task.handler,
            model: task.model,
            where: task.where,
            description: task.description || task.name,
            runs: 0,
            errors: 0,
            lastSuccess: null,
            lastError: null
        });
        
        console.log(`📋 Registered cleanup task: ${task.name}`);
    }

    /**
     * Run all registered cleanup tasks with mutex protection
     */
    async run() {
        if (this.isRunning) {
            console.log('⚠️  Cleanup already in progress, skipping this cycle');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();
        
        try {
            this.stats.totalRuns++;
            console.log(`🧹 Running cleanup cycle #${this.stats.totalRuns} with ${this.tasks.length} tasks...`);
            
            let tasksCompleted = 0;
            let tasksWithErrors = 0;
            
            for (const task of this.tasks) {
                try {
                    task.runs++;
                    
                    let result = null;
                    
                    if (typeof task.handler === 'function') {
                        // Function-based task
                        result = await task.handler();
                    } else if (task.model && task.where) {
                        // Model-based task (original format)
                        result = await task.model.destroy({ where: task.where });
                        if (result > 0) {
                            console.log(`🧹 ${task.name}: Cleaned up ${result} records from ${task.model.name}`);
                        }
                    } else {
                        throw new Error('Invalid task configuration');
                    }
                    
                    task.lastSuccess = new Date();
                    tasksCompleted++;
                    
                } catch (error) {
                    task.errors++;
                    task.lastError = error.message;
                    tasksWithErrors++;
                    this.stats.totalErrors++;
                    this.stats.lastError = `${task.name}: ${error.message}`;
                    
                    console.error(`❌ Cleanup task '${task.name}' failed:`, error.message);
                }
            }
            
            const duration = Date.now() - startTime;
            this.stats.lastRunTime = new Date();
            this.stats.lastRunDuration = duration;
            this.stats.totalTasksProcessed += tasksCompleted;
            
            if (tasksWithErrors > 0) {
                console.log(`⚠️  Cleanup completed with errors: ${tasksCompleted}/${this.tasks.length} tasks successful (${duration}ms)`);
            } else {
                console.log(`✅ Cleanup completed successfully: ${tasksCompleted}/${this.tasks.length} tasks completed (${duration}ms)`);
            }
            
        } catch (error) {
            this.stats.totalErrors++;
            this.stats.lastError = error.message;
            console.error('❌ Cleanup cycle failed:', error.message);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Start the cleanup service with interval scheduling
     */
    start() {
        console.log(`🧹 Starting cleanup service with ${this.cleanupConfig.interval}s interval...`);
        
        // Run immediately on startup
        this.run();
        
        // Schedule recurring runs
        setInterval(() => {
            this.run();
        }, this.cleanupConfig.interval * 1000);
    }

    /**
     * Get cleanup service status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            config: this.cleanupConfig,
            stats: { ...this.stats },
            tasks: this.tasks.map(task => ({
                name: task.name,
                description: task.description,
                runs: task.runs,
                errors: task.errors,
                lastSuccess: task.lastSuccess,
                lastError: task.lastError
            }))
        };
    }

    /**
     * Trigger immediate cleanup run (for testing/debugging)
     * @returns {Object} Run results
     */
    async triggerImmediate() {
        await this.run();
        return this.getStatus();
    }
}

export default new CleanupService();
