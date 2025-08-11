import config from '../config/ConfigLoader.js';
import { Op } from 'sequelize';

class CleanupService {
    constructor() {
        this.cleanupConfig = config.get('cleanup') || { interval: 300, retention_days: 7 };
        this.tasks = [];
    }

    registerTask(task) {
        this.tasks.push(task);
    }

    async run() {
        console.log('Running cleanup tasks...');
        for (const task of this.tasks) {
            try {
                const result = await task.model.destroy({ where: task.where });
                if (result > 0) {
                    console.log(`Cleaned up ${result} records from ${task.model.name}`);
                }
            } catch (error) {
                console.error(`Error cleaning up ${task.model.name}:`, error);
            }
        }
    }

    start() {
        console.log('Starting cleanup service...');
        this.run(); // Run on startup
        setInterval(() => {
            this.run();
        }, this.cleanupConfig.interval * 1000);
    }
}

export default new CleanupService();
