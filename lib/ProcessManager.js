/**
 * @fileoverview Process Manager for Zoneweaver API
 * @description Provides an interface for managing processes on OmniOS using advanced process management tools
 * @author Mark Gilbert
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
 * Parses the output of the `prstat` command into structured JSON format.
 * @param {string} prstatOutput - The raw output from the `prstat` command.
 * @returns {Array<Object>} An array of process objects.
 */
const parsePrstatOutput = (prstatOutput) => {
    const lines = prstatOutput.split('\n');
    const processes = [];
    
    // Find the header line and data lines
    let dataStartIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('PID') && lines[i].includes('USERNAME')) {
            dataStartIndex = i + 1;
            break;
        }
    }
    
    if (dataStartIndex === -1) return processes;
    
    // Parse each process line
    for (let i = dataStartIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('Total:') && !line.includes('load averages')) {
            const parts = line.split(/\s+/);
            if (parts.length >= 13) {
                processes.push({
                    pid: parseInt(parts[0]),
                    username: parts[1],
                    size: parts[2],
                    rss: parts[3],
                    state: parts[4],
                    pri: parseInt(parts[5]),
                    nice: parseInt(parts[6]),
                    time: parts[7],
                    cpu_percent: parseFloat(parts[8]),
                    command: parts.slice(12).join(' ')
                });
            }
        }
    }
    
    return processes;
};

/**
 * Parses the output of the `ps` command into structured JSON format.
 * @param {string} psOutput - The raw output from the `ps` command.
 * @returns {Array<Object>} An array of process objects.
 */
const parsePsOutput = (psOutput) => {
    const lines = psOutput.split('\n');
    const processes = [];
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            const parts = line.split(/\s+/);
            if (parts.length >= 8) {
                processes.push({
                    pid: parseInt(parts[0]),
                    ppid: parseInt(parts[1]),
                    uid: parseInt(parts[2]),
                    gid: parseInt(parts[3]),
                    sid: parseInt(parts[4]),
                    zone: parts[5],
                    tty: parts[6],
                    command: parts.slice(7).join(' ')
                });
            }
        }
    }
    
    return processes;
};

/**
 * Get list of processes with advanced filtering options
 * @param {Object} options - Filtering and display options
 * @param {string} options.zone - Filter by zone name
 * @param {string} options.user - Filter by username
 * @param {string} options.command - Filter by command pattern
 * @param {boolean} options.detailed - Use prstat for detailed CPU/memory info
 * @param {number} options.limit - Limit number of results
 * @returns {Promise<Array<Object>>} Array of process objects
 */
export const getProcesses = async (options = {}) => {
    let command;
    
    if (options.detailed) {
        // Use prstat for detailed CPU/memory information
        command = 'pfexec prstat -c -n 1 1';
        if (options.zone) {
            command += ` -Z ${options.zone}`;
        }
    } else {
        // Use ps for basic process listing with zone information
        command = 'pfexec ps -eo pid,ppid,uid,gid,sid,zone,tty,comm';
        if (options.zone) {
            command += ` -Z ${options.zone}`;
        }
    }
    
    const output = await executeCommand(command);
    const processes = options.detailed ? 
        parsePrstatOutput(output) : 
        parsePsOutput(output);
    
    // Apply additional filtering
    let filteredProcesses = processes;
    
    if (options.user) {
        filteredProcesses = filteredProcesses.filter(proc => 
            proc.username === options.user || proc.uid === options.user
        );
    }
    
    if (options.command) {
        const commandPattern = new RegExp(options.command, 'i');
        filteredProcesses = filteredProcesses.filter(proc => 
            commandPattern.test(proc.command)
        );
    }
    
    if (options.limit) {
        filteredProcesses = filteredProcesses.slice(0, options.limit);
    }
    
    return filteredProcesses;
};

/**
 * Get detailed information about a specific process
 * @param {number} pid - Process ID
 * @returns {Promise<Object>} Detailed process information
 */
export const getProcessDetails = async (pid) => {
    try {
        // Get basic process info
        const psCommand = `pfexec ps -p ${pid} -o pid,ppid,uid,gid,sid,zone,tty,time,vsz,rss,args`;
        const psOutput = await executeCommand(psCommand);
        
        // Parse ps output
        const lines = psOutput.split('\n');
        if (lines.length < 2) {
            throw new Error(`Process ${pid} not found`);
        }
        
        const processLine = lines[1].trim().split(/\s+/);
        const processInfo = {
            pid: parseInt(processLine[0]),
            ppid: parseInt(processLine[1]),
            uid: parseInt(processLine[2]),
            gid: parseInt(processLine[3]),
            sid: parseInt(processLine[4]),
            zone: processLine[5],
            tty: processLine[6],
            time: processLine[7],
            vsz: parseInt(processLine[8]),
            rss: parseInt(processLine[9]),
            command: processLine.slice(10).join(' ')
        };
        
        // Get additional details using pfiles, pstack, etc. if available
        try {
            const pfilesOutput = await executeCommand(`pfexec pfiles ${pid} 2>/dev/null | head -20`);
            processInfo.open_files_sample = pfilesOutput;
        } catch (error) {
            processInfo.open_files_sample = 'Unable to retrieve file information';
        }
        
        return processInfo;
    } catch (error) {
        if (error.message.includes('No such process')) {
            throw new Error(`Process ${pid} not found`);
        }
        throw error;
    }
};

/**
 * Send a signal to a process
 * @param {number} pid - Process ID
 * @param {string} signal - Signal name (TERM, KILL, HUP, etc.)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const signalProcess = async (pid, signal = 'TERM') => {
    try {
        const validSignals = ['TERM', 'KILL', 'HUP', 'INT', 'USR1', 'USR2', 'STOP', 'CONT'];
        if (!validSignals.includes(signal)) {
            return {
                success: false,
                error: `Invalid signal: ${signal}. Valid signals: ${validSignals.join(', ')}`
            };
        }
        
        await executeCommand(`kill -${signal} ${pid}`);
        return {
            success: true,
            message: `Signal ${signal} sent to process ${pid}`
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to send signal ${signal} to process ${pid}: ${error.message}`
        };
    }
};

/**
 * Kill a process (sends SIGTERM first, then SIGKILL if needed)
 * @param {number} pid - Process ID
 * @param {boolean} force - If true, send SIGKILL immediately
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const killProcess = async (pid, force = false) => {
    try {
        if (force) {
            return await signalProcess(pid, 'KILL');
        }
        
        // Try SIGTERM first
        const termResult = await signalProcess(pid, 'TERM');
        if (!termResult.success) {
            return termResult;
        }
        
        // Wait briefly and check if process is still alive
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        try {
            await executeCommand(`kill -0 ${pid}`);
            // Process still exists, send SIGKILL
            const killResult = await signalProcess(pid, 'KILL');
            return {
                success: killResult.success,
                message: `Process ${pid} terminated with SIGTERM, then SIGKILL`,
                error: killResult.error
            };
        } catch (error) {
            // Process no longer exists
            return {
                success: true,
                message: `Process ${pid} terminated with SIGTERM`
            };
        }
    } catch (error) {
        return {
            success: false,
            error: `Failed to kill process ${pid}: ${error.message}`
        };
    }
};

/**
 * Get open files for a process
 * @param {number} pid - Process ID
 * @returns {Promise<Array<Object>>} Array of open file objects
 */
export const getProcessFiles = async (pid) => {
    try {
        const output = await executeCommand(`pfexec pfiles ${pid}`);
        const files = [];
        const lines = output.split('\n');
        
        let currentFd = null;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.match(/^\d+:/)) {
                // File descriptor line
                currentFd = {
                    fd: parseInt(trimmed.split(':')[0]),
                    description: trimmed.split(':')[1]?.trim() || ''
                };
                files.push(currentFd);
            } else if (currentFd && trimmed) {
                // Additional file information
                currentFd.details = (currentFd.details || '') + ' ' + trimmed;
            }
        }
        
        return files;
    } catch (error) {
        throw new Error(`Failed to get files for process ${pid}: ${error.message}`);
    }
};

/**
 * Get process stack trace
 * @param {number} pid - Process ID
 * @returns {Promise<string>} Stack trace output
 */
export const getProcessStack = async (pid) => {
    try {
        const output = await executeCommand(`pfexec pstack ${pid}`);
        return output;
    } catch (error) {
        throw new Error(`Failed to get stack trace for process ${pid}: ${error.message}`);
    }
};

/**
 * Get process resource limits
 * @param {number} pid - Process ID
 * @returns {Promise<Object>} Resource limits information
 */
export const getProcessLimits = async (pid) => {
    try {
        const output = await executeCommand(`pfexec plimit ${pid}`);
        const limits = {};
        const lines = output.split('\n');
        
        for (const line of lines) {
            if (line.includes(':')) {
                const parts = line.split(':');
                if (parts.length >= 2) {
                    const key = parts[0].trim().toLowerCase().replace(/\s+/g, '_');
                    const value = parts[1].trim();
                    limits[key] = value;
                }
            }
        }
        
        return limits;
    } catch (error) {
        throw new Error(`Failed to get limits for process ${pid}: ${error.message}`);
    }
};

/**
 * Find processes by name using pgrep
 * @param {string} pattern - Process name pattern
 * @param {Object} options - Additional options
 * @param {string} options.zone - Filter by zone
 * @param {string} options.user - Filter by user
 * @returns {Promise<Array<number>>} Array of process IDs
 */
export const findProcesses = async (pattern, options = {}) => {
    try {
        let command = `pfexec pgrep`;
        
        if (options.user) {
            command += ` -u ${options.user}`;
        }
        
        if (options.zone) {
            command += ` -z ${options.zone}`;
        }
        
        command += ` ${pattern}`;
        
        const output = await executeCommand(command);
        return output.split('\n')
            .filter(line => line.trim())
            .map(pid => parseInt(pid))
            .filter(pid => !isNaN(pid));
    } catch (error) {
        // pgrep returns non-zero when no processes found
        if (error.message.includes('exit code 1')) {
            return [];
        }
        throw error;
    }
};

/**
 * Kill multiple processes by pattern
 * @param {string} pattern - Process name pattern
 * @param {Object} options - Additional options
 * @param {string} options.zone - Filter by zone
 * @param {string} options.user - Filter by user
 * @param {string} options.signal - Signal to send (default: TERM)
 * @returns {Promise<{success: boolean, killed: Array<number>, errors: Array<Object>}>}
 */
export const killProcessesByPattern = async (pattern, options = {}) => {
    try {
        const pids = await findProcesses(pattern, options);
        if (pids.length === 0) {
            return {
                success: true,
                killed: [],
                errors: [],
                message: 'No processes found matching pattern'
            };
        }
        
        const results = {
            success: true,
            killed: [],
            errors: []
        };
        
        const signal = options.signal || 'TERM';
        
        for (const pid of pids) {
            const result = await signalProcess(pid, signal);
            if (result.success) {
                results.killed.push(pid);
            } else {
                results.errors.push({ pid, error: result.error });
                results.success = false;
            }
        }
        
        return results;
    } catch (error) {
        return {
            success: false,
            killed: [],
            errors: [{ error: error.message }]
        };
    }
};

/**
 * Get real-time process statistics
 * @param {Object} options - Options for statistics
 * @param {string} options.zone - Filter by zone
 * @param {number} options.interval - Update interval in seconds
 * @param {number} options.count - Number of samples
 * @returns {Promise<Array<Object>>} Array of process statistics
 */
export const getProcessStats = async (options = {}) => {
    try {
        let command = `pfexec prstat -c`;
        
        if (options.zone) {
            command += ` -Z ${options.zone}`;
        }
        
        const interval = options.interval || 1;
        const count = options.count || 1;
        
        command += ` -n ${count} ${interval}`;
        
        const output = await executeCommand(command);
        return parsePrstatOutput(output);
    } catch (error) {
        throw new Error(`Failed to get process statistics: ${error.message}`);
    }
};
