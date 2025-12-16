/**
 * AgentRunner - Orchestrates AI coding agents running inside Apple Containers
 *
 * Supports:
 * - Codex CLI (@openai/codex)
 * - Claude Code CLI (@anthropic-ai/claude-code)
 *
 * Each agent runs inside an isolated Apple Container micro-VM with
 * a volume mount to the chat's dedicated folder.
 */

import { containerManager, ContainerRunStatus } from "./ContainerManager";
import type { AgentType } from "./api/ChatAPI";

export interface AgentMessage {
    type: "text" | "tool_use" | "tool_result" | "error" | "status";
    content: string;
    toolName?: string;
    toolArgs?: unknown;
    toolId?: string;
}

export interface AgentRunnerOptions {
    chatId: string;
    agentType: AgentType;
    apiKey: string;
    sessionId?: string;
    onMessage: (message: AgentMessage) => void;
    onStatusChange: (status: ContainerRunStatus) => void;
}

interface AgentSession {
    chatId: string;
    agentType: AgentType;
    containerName: string;
    folderPath: string;
    sessionId?: string;
    isRunning: boolean;
}

/**
 * Parses streaming output from Codex CLI
 * Codex outputs JSON-LD formatted events
 */
function parseCodexOutput(line: string): AgentMessage | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    try {
        const parsed = JSON.parse(trimmed);

        // Codex outputs different event types
        if (parsed.type === "message") {
            return {
                type: "text",
                content: parsed.content || parsed.text || "",
            };
        }

        if (parsed.type === "tool_call" || parsed.type === "function_call") {
            return {
                type: "tool_use",
                content: `Using tool: ${parsed.name || parsed.function?.name}`,
                toolName: parsed.name || parsed.function?.name,
                toolArgs: parsed.arguments || parsed.function?.arguments,
                toolId: parsed.id,
            };
        }

        if (parsed.type === "tool_result" || parsed.type === "function_result") {
            return {
                type: "tool_result",
                content: parsed.output || parsed.result || "",
                toolId: parsed.tool_call_id || parsed.id,
            };
        }

        if (parsed.type === "error") {
            return {
                type: "error",
                content: parsed.message || parsed.error || "Unknown error",
            };
        }

        // Fallback: treat as text
        return {
            type: "text",
            content: trimmed,
        };
    } catch {
        // Not JSON, treat as plain text output
        return {
            type: "text",
            content: trimmed,
        };
    }
}

/**
 * Parses streaming output from Claude Code CLI
 * Claude Code outputs structured JSON events
 */
function parseClaudeOutput(line: string): AgentMessage | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    try {
        const parsed = JSON.parse(trimmed);

        // Claude Agent SDK event types
        if (parsed.type === "content_block_delta") {
            if (parsed.delta?.type === "text_delta") {
                return {
                    type: "text",
                    content: parsed.delta.text || "",
                };
            }
            if (parsed.delta?.type === "input_json_delta") {
                // Tool input being streamed
                return undefined; // Skip partial tool input
            }
        }

        if (parsed.type === "content_block_start") {
            if (parsed.content_block?.type === "tool_use") {
                return {
                    type: "tool_use",
                    content: `Using tool: ${parsed.content_block.name}`,
                    toolName: parsed.content_block.name,
                    toolId: parsed.content_block.id,
                };
            }
        }

        if (parsed.type === "tool_result") {
            return {
                type: "tool_result",
                content:
                    typeof parsed.content === "string"
                        ? parsed.content
                        : JSON.stringify(parsed.content),
                toolId: parsed.tool_use_id,
            };
        }

        if (parsed.type === "error") {
            return {
                type: "error",
                content: parsed.error?.message || "Unknown error",
            };
        }

        if (parsed.type === "message_stop" || parsed.type === "message_delta") {
            return {
                type: "status",
                content:
                    parsed.type === "message_stop" ? "completed" : "streaming",
            };
        }

        // Fallback: treat as text
        if (typeof parsed === "string") {
            return {
                type: "text",
                content: parsed,
            };
        }

        return undefined;
    } catch {
        // Not JSON, treat as plain text output
        return {
            type: "text",
            content: trimmed,
        };
    }
}

export class AgentRunner {
    private sessions: Map<string, AgentSession> = new Map();
    private abortControllers: Map<string, AbortController> = new Map();

    /**
     * Initialize agent session for a chat
     */
    async initSession(
        chatId: string,
        agentType: AgentType,
    ): Promise<{ containerName: string; folderPath: string }> {
        // Ensure container service is running
        await containerManager.ensureServiceRunning();

        // Create/ensure agent folder exists
        const folderPath = await containerManager.ensureAgentFolder(chatId);

        // Start container with volume mount
        const containerName = await containerManager.startContainer(
            chatId,
            folderPath,
        );

        // Store session
        this.sessions.set(chatId, {
            chatId,
            agentType,
            containerName,
            folderPath,
            isRunning: false,
        });

        return { containerName, folderPath };
    }

    /**
     * Run an agent task with streaming output
     */
    async *runTask(
        chatId: string,
        prompt: string,
        options: {
            agentType: AgentType;
            apiKey: string;
            sessionId?: string;
        },
    ): AsyncIterable<AgentMessage> {
        const session = this.sessions.get(chatId);
        if (!session) {
            throw new Error(
                `No session found for chat ${chatId}. Call initSession first.`,
            );
        }

        const abortController = new AbortController();
        this.abortControllers.set(chatId, abortController);

        session.isRunning = true;
        session.sessionId = options.sessionId;

        try {
            // Build the agent command based on type
            const command = this.buildAgentCommand(
                options.agentType,
                prompt,
                options.apiKey,
                options.sessionId,
            );

            // Execute inside container and stream output
            const parseOutput =
                options.agentType === "codex"
                    ? parseCodexOutput
                    : parseClaudeOutput;

            for await (const line of containerManager.exec(
                session.containerName,
                command,
            )) {
                // Check if aborted
                if (abortController.signal.aborted) {
                    yield {
                        type: "status",
                        content: "aborted",
                    };
                    break;
                }

                const message = parseOutput(line);
                if (message) {
                    yield message;
                }
            }

            yield {
                type: "status",
                content: "completed",
            };
        } catch (error) {
            yield {
                type: "error",
                content:
                    error instanceof Error ? error.message : "Unknown error",
            };
        } finally {
            session.isRunning = false;
            this.abortControllers.delete(chatId);
        }
    }

    /**
     * Build the command array to run inside the container
     */
    private buildAgentCommand(
        agentType: AgentType,
        prompt: string,
        apiKey: string,
        sessionId?: string,
    ): string[] {
        if (agentType === "codex") {
            // Codex CLI command
            const cmd = [
                "sh",
                "-c",
                `OPENAI_API_KEY="${apiKey}" codex exec --output-format json "${prompt.replace(/"/g, '\\"')}"`,
            ];
            return cmd;
        } else {
            // Claude Code CLI command
            const cmd = [
                "sh",
                "-c",
                `ANTHROPIC_API_KEY="${apiKey}" claude-code --output-format json${sessionId ? ` --session-id ${sessionId}` : ""} "${prompt.replace(/"/g, '\\"')}"`,
            ];
            return cmd;
        }
    }

    /**
     * Stop a running agent task
     */
    async stopTask(chatId: string): Promise<void> {
        const abortController = this.abortControllers.get(chatId);
        if (abortController) {
            abortController.abort();
        }

        const session = this.sessions.get(chatId);
        if (session) {
            session.isRunning = false;
        }
    }

    /**
     * Stop container and clean up session
     */
    async endSession(chatId: string): Promise<void> {
        await this.stopTask(chatId);

        const session = this.sessions.get(chatId);
        if (session) {
            await containerManager.stopContainer(session.containerName);
            this.sessions.delete(chatId);
        }
    }

    /**
     * Check if a session exists and is running
     */
    isRunning(chatId: string): boolean {
        return this.sessions.get(chatId)?.isRunning ?? false;
    }

    /**
     * Get session info
     */
    getSession(chatId: string): AgentSession | undefined {
        return this.sessions.get(chatId);
    }

    /**
     * Get the folder path for a chat
     */
    async getFolderPath(chatId: string): Promise<string> {
        return containerManager.getAgentFolderPath(chatId);
    }

    /**
     * Check if agent dependencies are available
     */
    async checkAgentAvailability(agentType: AgentType): Promise<{
        available: boolean;
        message?: string;
    }> {
        // Check container status first
        const containerStatus = await containerManager.checkStatus();

        if (containerStatus === "not_installed") {
            return {
                available: false,
                message:
                    "Apple Container CLI is not installed. Please install from https://github.com/apple/container",
            };
        }

        if (containerStatus === "service_stopped") {
            return {
                available: false,
                message:
                    'Container service is not running. Run "container system start" to start it.',
            };
        }

        if (containerStatus === "image_missing") {
            return {
                available: false,
                message:
                    "Agent container image not found. Please build the chorus-agent-image first.",
            };
        }

        // Container is ready
        return { available: true };
    }
}

// Export singleton instance
export const agentRunner = new AgentRunner();
