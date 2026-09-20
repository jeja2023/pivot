'use strict';

const { executeTerminalRuntime, isTerminalRuntimeAvailable } = require('./agent-terminal-runtime');

function terminalToolDefinition(asJsonSchema) {
    return {
        name: 'terminal.runtime',
        title: '受控终端与代码执行',
        requiresSandbox: true,
        alwaysRequiresApproval: true,
        side_effect: true,
        cancellable: true,
        description: '在本任务独立、默认断网的受控工作区执行 Node/Python，或只读检查 Git/ripgrep；可读写该工作区文件。不会打开宿主机 Shell、用户目录或任意网络。',
        input_schema: asJsonSchema({
            action: { type: 'string', enum: ['exec', 'write', 'read', 'list'], default: 'exec' },
            command: { type: 'string', enum: ['node', 'python', 'git', 'rg'], description: 'exec 时必填；Git 与 rg 仅限只读子命令。' },
            args: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 32 },
            script: { type: 'string', maxLength: 262144, description: 'Node/Python 脚本内容；会写入当前任务受控工作区。' },
            scriptPath: { type: 'string', maxLength: 240, description: '工作区内脚本或读写文件路径，不允许 .. 或绝对路径。' },
            path: { type: 'string', maxLength: 240, description: 'read/write/list 的工作区内路径。' },
            content: { type: 'string', maxLength: 524288, description: 'write 的 UTF-8 文件内容。' },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 }
        }),
        output_schema: {
            type: 'object',
            required: ['action', 'workspace'],
            properties: {
                action: { type: 'string' }, command: { type: 'string' }, exitCode: { type: 'integer' },
                stdout: { type: 'string' }, stderr: { type: 'string' }, path: { type: 'string' },
                content: { type: 'string' }, entries: { type: 'array' }, workspace: { type: 'object' }
            }
        }
    };
}

module.exports = { executeTerminalRuntime, isTerminalRuntimeAvailable, terminalToolDefinition };
