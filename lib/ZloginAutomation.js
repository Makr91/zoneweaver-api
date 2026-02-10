/**
 * @fileoverview Zlogin Automation Engine for Zoneweaver API
 * @description Expect-like automation engine for programmatic zlogin console interaction.
 *              Executes recipes against zones for early-boot configuration (network, user creation)
 *              BEFORE SSH is available. Backend automation service, separate from the interactive
 *              WebSocket terminal in ZloginController.js.
 */

import pty from 'node-pty';
import { log } from './Logger.js';

/**
 * Zlogin Automation Engine
 * Spawns a zlogin console session and executes recipe steps programmatically.
 */
class ZloginAutomation {
  /**
   * @param {string} zoneName - Name of the zone to connect to
   * @param {Object} [options]
   * @param {number} [options.cols=80] - Terminal columns
   * @param {number} [options.rows=30] - Terminal rows
   * @param {number} [options.defaultTimeout=30000] - Default timeout for wait steps (ms)
   * @param {number} [options.globalTimeout=300000] - Global timeout for entire recipe (ms)
   */
  constructor(zoneName, options = {}) {
    this.zoneName = zoneName;
    this.cols = options.cols || 80;
    this.rows = options.rows || 30;
    this.defaultTimeout = options.defaultTimeout || 30000;
    this.globalTimeout = options.globalTimeout || 300000;
    this.ptyProcess = null;
    this.outputBuffer = '';
    this.executionLog = [];
    this.destroyed = false;
  }

  /**
   * Spawn the zlogin console PTY process
   * @returns {Promise<void>}
   */
  spawn() {
    if (this.ptyProcess) {
      throw new Error('PTY process already spawned');
    }

    return new Promise((resolve, reject) => {
      try {
        this.ptyProcess = pty.spawn('bash', ['-c', `pfexec zlogin -C ${this.zoneName}`], {
          name: 'xterm-color',
          cols: this.cols,
          rows: this.rows,
          env: process.env,
        });

        this.ptyProcess.on('data', data => {
          this.outputBuffer += data;
        });

        this.ptyProcess.on('error', error => {
          log.task.error('Zlogin PTY error', {
            zone_name: this.zoneName,
            error: error.message,
          });
        });

        this.ptyProcess.on('exit', (code, signal) => {
          log.task.info('Zlogin PTY exited', {
            zone_name: this.zoneName,
            code,
            signal,
          });
        });

        // Give PTY a moment to initialize
        setTimeout(() => resolve(), 500);
      } catch (error) {
        reject(new Error(`Failed to spawn zlogin PTY: ${error.message}`));
      }
    });
  }

  /**
   * Execute a recipe against the zone
   * @param {Object} recipe - Recipe object with steps and metadata
   * @param {Object} [variables={}] - Variables for template resolution
   * @returns {Promise<{success: boolean, output: string[], errors: string[]}>}
   */
  async execute(recipe, variables = {}) {
    if (this.destroyed) {
      return { success: false, output: [], errors: ['Automation engine has been destroyed'] };
    }

    const mergedVars = {
      ...recipe.variables,
      ...variables,
      // Standard recipe fields available as variables
      login_prompt: recipe.login_prompt || 'login:',
      shell_prompt: recipe.shell_prompt || ':~$',
      boot_string: recipe.boot_string || '',
    };

    const errors = [];
    const output = [];
    const globalDeadline = Date.now() + this.globalTimeout;

    try {
      await this.spawn();

      // If boot_string is set, wait for it first
      if (recipe.boot_string) {
        log.task.info('Waiting for boot string', {
          zone_name: this.zoneName,
          pattern: recipe.boot_string,
        });
        const bootTimeout = (recipe.timeout_seconds || 300) * 1000;
        const bootResult = await this._waitForPattern(
          recipe.boot_string,
          bootTimeout,
          globalDeadline
        );
        if (!bootResult.matched) {
          errors.push(`Boot wait timed out waiting for: ${recipe.boot_string}`);
          return { success: false, output, errors };
        }
        output.push(`Boot detected: ${recipe.boot_string}`);
      }

      // Execute each step
      const executeSteps = async index => {
        if (index >= recipe.steps.length) {
          return;
        }

        if (this.destroyed) {
          errors.push('Automation was cancelled');
          return;
        }

        if (Date.now() >= globalDeadline) {
          errors.push('Global timeout exceeded');
          return;
        }

        const step = recipe.steps[index];
        const stepResult = await this._executeStep(step, mergedVars, globalDeadline);
        this.executionLog.push({
          step: index,
          type: step.type,
          ...stepResult,
        });

        if (stepResult.output) {
          output.push(stepResult.output);
        }

        if (!stepResult.success) {
          errors.push(stepResult.error || `Step ${index} (${step.type}) failed`);
          return;
        }

        await executeSteps(index + 1);
      };

      await executeSteps(0);
    } catch (error) {
      errors.push(`Execution error: ${error.message}`);
    }

    return {
      success: errors.length === 0,
      output,
      errors,
      log: this.executionLog,
    };
  }

  /**
   * Execute a single recipe step
   * @param {Object} step - Step definition
   * @param {Object} vars - Resolved variables
   * @param {number} globalDeadline - Absolute deadline timestamp
   * @returns {Promise<{success: boolean, output?: string, error?: string}>}
   * @private
   */
  _executeStep(step, vars, globalDeadline) {
    switch (step.type) {
      case 'wait':
        return this._stepWait(step, vars, globalDeadline);
      case 'send':
        return this._stepSend(step, vars);
      case 'command':
        return this._stepCommand(step, vars, globalDeadline);
      case 'template':
        return this._stepTemplate(step, vars, globalDeadline);
      case 'delay':
        return this._stepDelay(step);
      default:
        return { success: false, error: `Unknown step type: ${step.type}` };
    }
  }

  /**
   * Wait for a pattern in console output
   * @private
   */
  async _stepWait(step, vars, globalDeadline) {
    const pattern = this._resolveVars(step.pattern, vars);
    const timeout = Math.min(
      (step.timeout || this.defaultTimeout / 1000) * 1000,
      globalDeadline - Date.now()
    );

    const result = await this._waitForPattern(pattern, timeout, globalDeadline);
    if (result.matched) {
      return { success: true, output: `Matched pattern: ${pattern}` };
    }
    return { success: false, error: `Timeout waiting for pattern: ${pattern}` };
  }

  /**
   * Send text to the console
   * @private
   */
  _stepSend(step, vars) {
    if (!this.ptyProcess || this.ptyProcess.killed) {
      return { success: false, error: 'PTY process not available' };
    }

    const value = this._resolveVars(step.value, vars);
    this.ptyProcess.write(value);
    return { success: true, output: `Sent: ${value.replace(/\r?\n/g, '\\n')}` };
  }

  /**
   * Execute a command and optionally verify exit code
   * @private
   */
  async _stepCommand(step, vars, globalDeadline) {
    if (!this.ptyProcess || this.ptyProcess.killed) {
      return { success: false, error: 'PTY process not available' };
    }

    const command = this._resolveVars(step.value, vars);
    const expectPrompt = step.expect_prompt
      ? this._resolveVars(step.expect_prompt, vars)
      : this._resolveVars('{{shell_prompt}}', vars);
    const timeout = Math.min(
      (step.timeout || this.defaultTimeout / 1000) * 1000,
      globalDeadline - Date.now()
    );

    // Clear buffer to capture only this command's output
    this.outputBuffer = '';

    // Send the command followed by an exit code marker
    const marker = `ZWEC_${Date.now()}`;
    this.ptyProcess.write(`${command}; echo "${marker}:$?"\r\n`);

    // Wait for the exit code marker
    const result = await this._waitForPattern(marker, timeout, globalDeadline);
    if (!result.matched) {
      return { success: false, error: `Command timed out: ${command}` };
    }

    // Extract exit code from the marker
    const markerMatch = this.outputBuffer.match(new RegExp(`${marker}:(\\d+)`));
    const exitCode = markerMatch ? parseInt(markerMatch[1], 10) : -1;

    if (step.check_exit_code !== false && exitCode !== 0) {
      return {
        success: false,
        error: `Command failed with exit code ${exitCode}: ${command}`,
        output: this.outputBuffer,
      };
    }

    // Wait for shell prompt to return
    await this._waitForPattern(expectPrompt, 5000, globalDeadline);

    return {
      success: true,
      output: `Command executed (exit ${exitCode}): ${command}`,
    };
  }

  /**
   * Write a template file to the zone via echo redirection
   * @private
   */
  async _stepTemplate(step, vars, globalDeadline) {
    if (!this.ptyProcess || this.ptyProcess.killed) {
      return { success: false, error: 'PTY process not available' };
    }

    const content = this._resolveVars(step.content, vars);
    const dest = this._resolveVars(step.dest, vars);
    const method = step.method || 'echo_redirect';
    const timeout = Math.min((step.timeout || 30) * 1000, globalDeadline - Date.now());

    if (method === 'echo_redirect') {
      // Write content line by line via echo redirection
      const lines = content.split('\n');

      // First line creates/truncates the file
      this.ptyProcess.write(`echo '${this._escapeShell(lines[0])}' > ${dest}\r\n`);
      await this._waitForDelay(200);

      // Remaining lines append

      const writeLines = async index => {
        if (index >= lines.length) {
          return;
        }
        this.ptyProcess.write(`echo '${this._escapeShell(lines[index])}' >> ${dest}\r\n`);
        await this._waitForDelay(200);
        await writeLines(index + 1);
      };

      await writeLines(1);

      // Wait for prompt to return
      const expectPrompt = this._resolveVars(step.expect_prompt || '{{shell_prompt}}', vars);
      await this._waitForPattern(expectPrompt, timeout, globalDeadline);

      return { success: true, output: `Template written to ${dest}` };
    } else if (method === 'heredoc') {
      const marker = `ZWEOD_${Date.now()}`;
      this.ptyProcess.write(`cat > ${dest} << '${marker}'\r\n`);
      this.ptyProcess.write(`${content}\r\n`);
      this.ptyProcess.write(`${marker}\r\n`);

      // Wait for prompt
      const expectPrompt = this._resolveVars(step.expect_prompt || '{{shell_prompt}}', vars);
      await this._waitForPattern(expectPrompt, timeout, globalDeadline);

      return { success: true, output: `Template written to ${dest} (heredoc)` };
    }

    return { success: false, error: `Unknown template method: ${method}` };
  }

  /**
   * Delay for a specified number of seconds
   * @private
   */
  async _stepDelay(step) {
    const seconds = step.seconds || 1;
    await this._waitForDelay(seconds * 1000);
    return { success: true, output: `Delayed ${seconds}s` };
  }

  /**
   * Wait for a pattern to appear in the output buffer
   * @param {string} pattern - String or regex pattern to match
   * @param {number} timeout - Timeout in milliseconds
   * @param {number} globalDeadline - Absolute deadline timestamp
   * @returns {Promise<{matched: boolean, match?: string}>}
   * @private
   */
  _waitForPattern(pattern, timeout, globalDeadline) {
    return new Promise(resolve => {
      const deadline = Math.min(Date.now() + timeout, globalDeadline);
      const regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

      // Check if already in buffer
      if (regex.test(this.outputBuffer)) {
        resolve({ matched: true, match: pattern });
        return;
      }

      const interval = setInterval(() => {
        if (this.destroyed || !this.ptyProcess || this.ptyProcess.killed) {
          clearInterval(interval);
          resolve({ matched: false });
          return;
        }

        if (regex.test(this.outputBuffer)) {
          clearInterval(interval);
          resolve({ matched: true, match: pattern });
          return;
        }

        if (Date.now() >= deadline) {
          clearInterval(interval);
          resolve({ matched: false });
        }
      }, 250);
    });
  }

  /**
   * Wait for a specified delay
   * @param {number} ms - Milliseconds to wait
   * @returns {Promise<void>}
   * @private
   */
  _waitForDelay(ms) {
    return new Promise(resolve => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Resolve {{variable}} placeholders in a string
   * @param {string} str - String with placeholders
   * @param {Object} vars - Variable map
   * @returns {string}
   * @private
   */
  _resolveVars(str, vars) {
    if (!str) {
      return str;
    }
    return str.replace(/\{\{(?<varname>\w+)\}\}/gu, (match, ...args) => {
      const { varname } = args[args.length - 1];
      return vars[varname] !== undefined ? vars[varname] : match;
    });
  }

  /**
   * Escape string for use in shell single quotes
   * @param {string} str - String to escape
   * @returns {string}
   * @private
   */
  _escapeShell(str) {
    return str.replace(/'/g, "'\\''");
  }

  /**
   * Get the current output buffer contents
   * @returns {string}
   */
  getOutput() {
    return this.outputBuffer;
  }

  /**
   * Get the execution log
   * @returns {Array}
   */
  getLog() {
    return this.executionLog;
  }

  /**
   * Destroy the automation engine and clean up resources
   */
  destroy() {
    this.destroyed = true;

    if (this.ptyProcess) {
      try {
        // Send escape sequence to detach from zlogin console (~.)
        this.ptyProcess.write('~.\r\n');

        setTimeout(() => {
          try {
            if (!this.ptyProcess.killed) {
              this.ptyProcess.kill();
            }
          } catch {
            // Process already exited
          }
        }, 1000);
      } catch {
        // Ignore cleanup errors
      }
      this.ptyProcess = null;
    }

    log.task.info('Zlogin automation engine destroyed', {
      zone_name: this.zoneName,
    });
  }
}

export default ZloginAutomation;
