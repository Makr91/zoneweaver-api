/**
 * @fileoverview Service Manager for Zoneweaver API
 * @description Provides an interface for interacting with the Solaris Service Management Facility (SMF).
 * @author Cline

 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Executes a shell command and returns the output.
 * @param {string} command - The command to execute.
 * @returns {Promise<string>} The stdout of the command.
 */
const executeCommand = async (command) => {
    try {
        const { stdout } = await execAsync(command);
        return stdout.trim();
    } catch (error) {
        console.error(`Error executing command: ${command}`, error);
        throw error;
    }
};

/**
 * Parses the output of the `svcs` command into a structured JSON format.
 * @param {string} svcsOutput - The raw output from the `svcs` command.
 * @returns {Array<Object>} An array of service objects.
 */
const parseSvcsOutput = (svcsOutput) => {
    const lines = svcsOutput.split('\n');
    const services = [];

    // Skip the header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            const parts = line.split(/\s+/);
            const state = parts[0];
            const stime = parts[1];
            const fmri = parts[2];
            services.push({ state, stime, fmri });
        }
    }

    return services;
};

/**
 * Retrieves a list of services from the SMF.
 * @param {Object} options - The options for the `svcs` command.
 * @returns {Promise<Array<Object>>} A list of services.
 */
export const getServices = async (options = {}) => {
    let command = 'svcs';

    if (options.pattern) {
        command += ` ${options.pattern}`;
    }

    if (options.zone) {
        command += ` -z ${options.zone}`;
    }

    if (options.all) {
        command += ' -a';
    }

    const output = await executeCommand(command);
    return parseSvcsOutput(output);
};

/**
 * Parses the output of the `svcs -l` command into a structured JSON format.
 * @param {string} svcsLOutput - The raw output from the `svcs -l` command.
 * @returns {Object} A service object.
 */
const parseSvcsLOutput = (svcsLOutput) => {
    const lines = svcsLOutput.split('\n');
    const service = {};

    lines.forEach(line => {
        const parts = line.split(':');
        const key = parts[0].trim();
        const value = parts.slice(1).join(':').trim();
        service[key] = value;
    });

    return service;
};

/**
 * Retrieves detailed information about a specific service from the SMF.
 * @param {string} fmri - The FMRI of the service.
 * @returns {Promise<Object>} A service object.
 */
export const getServiceDetails = async (fmri) => {
    const command = `svcs -l ${fmri}`;
    const output = await executeCommand(command);
    return parseSvcsLOutput(output);
};

/**
 * Enables a service.
 * @param {string} fmri - The FMRI of the service.
 * @param {Object} options - The options for the `svcadm enable` command.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>} The result of the operation.
 */
export const enableService = async (fmri, options = {}) => {
    try {
        let command = 'pfexec svcadm enable';
        if (options.recursive) {
            command += ' -r';
        }
        if (options.sync) {
            command += ' -s';
        }
        if (options.temporary) {
            command += ' -t';
        }
        command += ` ${fmri}`;
        
        const output = await executeCommand(command);
        return {
            success: true,
            message: `Service ${fmri} enabled successfully`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to enable service ${fmri}: ${error.message}`
        };
    }
};

/**
 * Disables a service.
 * @param {string} fmri - The FMRI of the service.
 * @param {Object} options - The options for the `svcadm disable` command.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>} The result of the operation.
 */
export const disableService = async (fmri, options = {}) => {
    try {
        let command = 'pfexec svcadm disable';
        if (options.sync) {
            command += ' -s';
        }
        if (options.temporary) {
            command += ' -t';
        }
        command += ` ${fmri}`;
        
        const output = await executeCommand(command);
        return {
            success: true,
            message: `Service ${fmri} disabled successfully`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to disable service ${fmri}: ${error.message}`
        };
    }
};

/**
 * Restarts a service.
 * @param {string} fmri - The FMRI of the service.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>} The result of the operation.
 */
export const restartService = async (fmri) => {
    try {
        const command = `pfexec svcadm restart ${fmri}`;
        const output = await executeCommand(command);
        return {
            success: true,
            message: `Service ${fmri} restarted successfully`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to restart service ${fmri}: ${error.message}`
        };
    }
};

/**
 * Refreshes a service.
 * @param {string} fmri - The FMRI of the service.
 * @returns {Promise<{success: boolean, message?: string, error?: string}>} The result of the operation.
 */
export const refreshService = async (fmri) => {
    try {
        const command = `pfexec svcadm refresh ${fmri}`;
        const output = await executeCommand(command);
        return {
            success: true,
            message: `Service ${fmri} refreshed successfully`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to refresh service ${fmri}: ${error.message}`
        };
    }
};

/**
 * Parses the output of the `svccfg -s <fmri> listprop` command into a structured JSON format.
 * @param {string} svccfgOutput - The raw output from the `svccfg` command.
 * @returns {Object} An object of properties.
 */
const parseSvccfgListpropOutput = (svccfgOutput) => {
    const lines = svccfgOutput.split('\n');
    const properties = {};
    let currentPg = '';

    lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
            const pgOrProp = parts[0];
            const type = parts[1];

            if (pgOrProp.includes('/')) {
                // This is a property
                const [pg, prop] = pgOrProp.split('/');
                if (!properties[pg]) {
                    properties[pg] = {};
                }
                const value = parts.slice(2).join(' ');
                properties[pg][prop] = {
                    type,
                    value
                };
            } else {
                // This is a property group
                currentPg = pgOrProp;
                properties[currentPg] = {
                    type,
                    properties: {}
                };
            }
        }
    });

    return properties;
};

/**
 * Retrieves the properties of a service from the SMF.
 * @param {string} fmri - The FMRI of the service.
 * @returns {Promise<Object>} An object of properties.
 */
export const getProperties = async (fmri) => {
    const command = `pfexec svccfg -s ${fmri} listprop`;
    const output = await executeCommand(command);
    return parseSvccfgListpropOutput(output);
};
