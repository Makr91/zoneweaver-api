/**
 * @fileoverview Reconciliation Service for Zoneweaver API
 * @description Periodically scans the host system and reconciles the database with the actual state of the system.
 * @author Mark Gilbert

 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import Zones from '../models/ZoneModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import { execSync } from 'child_process';
import os from 'os';

class ReconciliationService {
    constructor() {
        this.reconciliationConfig = config.get('reconciliation') || { enabled: true, interval: 3600, log_level: 'info' };
        this.isReconciling = false;
    }

    async reconcile() {
        if (this.isReconciling) {
            return;
        }

        this.isReconciling = true;

        try {
            if (this.reconciliationConfig.log_level === 'info' || this.reconciliationConfig.log_level === 'debug') {
                console.log('Starting reconciliation...');
            }

            // Reconcile zones
            await this.reconcileZones();

            // Reconcile network interfaces
            await this.reconcileNetworkInterfaces();

            if (this.reconciliationConfig.log_level === 'info' || this.reconciliationConfig.log_level === 'debug') {
                console.log('Reconciliation complete.');
            }
        } catch (error) {
            console.error('Error during reconciliation:', error);
        } finally {
            this.isReconciling = false;
        }
    }

    async reconcileZones() {
        try {
            const systemZones = execSync('zoneadm list -c').toString().split('\n').filter(Boolean);
            const dbZones = await Zones.findAll({ where: { host: os.hostname() } });

            // Find orphaned zones
            for (const dbZone of dbZones) {
                if (!systemZones.includes(dbZone.name)) {
                    if (this.reconciliationConfig.log_level === 'debug') {
                        console.log(`Found orphaned zone: ${dbZone.name}`);
                    }
                    await dbZone.destroy();
                }
            }
        } catch (error) {
            console.error('Error reconciling zones:', error);
        }
    }

    async reconcileNetworkInterfaces() {
        await this.reconcileResourceType('vnic', 'dladm show-vnic -p -o link');
        await this.reconcileResourceType('aggr', 'dladm show-aggr -p -o link');
        await this.reconcileResourceType('bridge', 'dladm show-bridge -p -o bridge');
        await this.reconcileResourceType('etherstub', 'dladm show-etherstub -p');
        await this.reconcileResourceType('vlan', 'dladm show-vlan -p -o link');
    }

    async reconcileResourceType(resourceClass, command) {
        try {
            if (this.reconciliationConfig.log_level === 'debug') {
                console.log(`Reconciling ${resourceClass}s...`);
            }
            const systemResources = execSync(command).toString().split('\n').filter(Boolean).map(line => line.split(':')[0]);
            const dbResources = await NetworkInterfaces.findAll({ where: { host: os.hostname(), class: resourceClass } });

            for (const dbResource of dbResources) {
                if (!systemResources.includes(dbResource.link)) {
                    if (this.reconciliationConfig.log_level === 'debug') {
                        console.log(`Found orphaned ${resourceClass}: ${dbResource.link}`);
                    }
                    await dbResource.destroy();
                }
            }
        } catch (error) {
            console.error(`Error reconciling ${resourceClass}s:`, error);
        }
    }

    start() {
        if (this.reconciliationConfig.enabled) {
            console.log('Starting reconciliation service...');
            this.reconcile(); // Run on startup
            setInterval(() => {
                this.reconcile();
            }, this.reconciliationConfig.interval * 1000);
        }
    }
}

export default new ReconciliationService();
