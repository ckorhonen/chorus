/**
 * AgentAPI - TanStack Query hooks for agent mode functionality
 *
 * Handles running agent tasks and streaming output to chat messages.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { v4 as uuidv4 } from "uuid";
import { db } from "../DB";
import { agentRunner, AgentMessage } from "../AgentRunner";
import { containerManager } from "../ContainerManager";
import type { AgentType, Chat } from "./ChatAPI";
import { chatQueries, useUpdateAgentSession } from "./ChatAPI";
import { createAIMessage, MessagePart } from "../ChatState";
import type { UserToolCall, UserToolResult } from "../Toolsets";
import { getApiKeys } from "./AppMetadataAPI";

const AGENT_MODEL_PREFIX = "agent::";

function getAgentModelId(agentType: AgentType): string {
    return `${AGENT_MODEL_PREFIX}${agentType}`;
}

/**
 * Hook to initialize an agent session for a chat
 */
export function useInitAgentSession() {
    const queryClient = useQueryClient();
    const updateAgentSession = useUpdateAgentSession();

    return useMutation({
        mutationKey: ["initAgentSession"] as const,
        mutationFn: async ({
            chatId,
            agentType,
        }: {
            chatId: string;
            agentType: AgentType;
        }) => {
            // Initialize the agent session
            const { containerName, folderPath } = await agentRunner.initSession(
                chatId,
                agentType,
            );

            // Update the chat with session info
            await updateAgentSession.mutateAsync({
                chatId,
                containerId: containerName,
            });

            return { containerName, folderPath };
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries(
                chatQueries.detail(variables.chatId),
            );
        },
    });
}

/**
 * Hook to run an agent task and stream output to a message
 */
export function useRunAgentTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationKey: ["runAgentTask"] as const,
        mutationFn: async ({
            chatId,
            messageId,
            messageSetId,
            prompt,
            agentType,
            sessionId,
        }: {
            chatId: string;
            messageId: string;
            messageSetId: string;
            prompt: string;
            agentType: AgentType;
            sessionId?: string;
        }) => {
            // Get API keys
            const apiKeys = await getApiKeys();
            const apiKey =
                agentType === "codex" ? apiKeys.openai : apiKeys.anthropic;

            if (!apiKey) {
                throw new Error(
                    `No API key found for ${agentType}. Please add your ${agentType === "codex" ? "OpenAI" : "Anthropic"} API key in Settings.`,
                );
            }

            // Ensure agent session is initialized
            const session = agentRunner.getSession(chatId);
            if (!session) {
                await agentRunner.initSession(chatId, agentType);
            }

            // Stream token for this message
            const streamingToken = uuidv4();

            // Update message to streaming state
            await db.execute(
                `UPDATE messages SET state = 'streaming', streaming_token = ? WHERE id = ?`,
                [streamingToken, messageId],
            );

            // Track message parts and accumulated text
            let accumulatedText = "";
            let currentPartLevel = 0;
            const toolCalls: UserToolCall[] = [];
            const toolResults: UserToolResult[] = [];

            // Run the agent task and stream output
            try {
                for await (const message of agentRunner.runTask(chatId, prompt, {
                    agentType,
                    apiKey,
                    sessionId,
                })) {
                    // Process agent message
                    switch (message.type) {
                        case "text":
                            accumulatedText += message.content;
                            // Update message text in database
                            await db.execute(
                                `UPDATE messages SET text = ? WHERE id = ? AND streaming_token = ?`,
                                [accumulatedText, messageId, streamingToken],
                            );
                            break;

                        case "tool_use":
                            // Create tool call record
                            const toolCall: UserToolCall = {
                                id: message.toolId ?? uuidv4(),
                                namespacedToolName: `agent_${message.toolName}`,
                                args: message.toolArgs,
                                toolMetadata: {
                                    description: `Agent tool: ${message.toolName}`,
                                },
                            };
                            toolCalls.push(toolCall);
                            break;

                        case "tool_result":
                            // Create tool result record
                            const toolResult: UserToolResult = {
                                id: message.toolId ?? uuidv4(),
                                content: message.content,
                            };
                            toolResults.push(toolResult);
                            break;

                        case "error":
                            // Set error state on message
                            await db.execute(
                                `UPDATE messages SET state = 'idle', error_message = ? WHERE id = ?`,
                                [message.content, messageId],
                            );
                            throw new Error(message.content);

                        case "status":
                            if (message.content === "completed") {
                                // Task completed successfully
                            } else if (message.content === "aborted") {
                                // Task was aborted
                                await db.execute(
                                    `UPDATE messages SET state = 'idle', error_message = 'Task aborted' WHERE id = ?`,
                                    [messageId],
                                );
                            }
                            break;
                    }

                    // Invalidate queries to trigger UI updates
                    void queryClient.invalidateQueries({
                        queryKey: ["chats", chatId, "messageSets"],
                    });
                }

                // Save message parts with tool calls/results if any
                if (toolCalls.length > 0 || toolResults.length > 0) {
                    await db.execute(
                        `INSERT INTO message_parts (chat_id, message_id, level, content, tool_calls, tool_results)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            chatId,
                            messageId,
                            currentPartLevel,
                            accumulatedText,
                            JSON.stringify(toolCalls),
                            JSON.stringify(toolResults),
                        ],
                    );
                } else {
                    // Just save the text content
                    await db.execute(
                        `INSERT INTO message_parts (chat_id, message_id, level, content, tool_calls, tool_results)
                         VALUES (?, ?, ?, ?, NULL, NULL)`,
                        [chatId, messageId, currentPartLevel, accumulatedText],
                    );
                }

                // Mark message as complete
                await db.execute(
                    `UPDATE messages SET state = 'idle', streaming_token = NULL WHERE id = ? AND streaming_token = ?`,
                    [messageId, streamingToken],
                );

                return { success: true };
            } catch (error) {
                // Handle errors
                const errorMessage =
                    error instanceof Error ? error.message : "Unknown error";
                await db.execute(
                    `UPDATE messages SET state = 'idle', streaming_token = NULL, error_message = ? WHERE id = ?`,
                    [errorMessage, messageId],
                );
                throw error;
            } finally {
                // Final invalidation
                void queryClient.invalidateQueries({
                    queryKey: ["chats", chatId, "messageSets"],
                });
            }
        },
    });
}

/**
 * Hook to populate an agent response block
 * This is the agent-mode equivalent of usePopulateToolsBlock
 */
export function usePopulateAgentBlock(chatId: string) {
    const queryClient = useQueryClient();
    const runAgentTask = useRunAgentTask();

    return useMutation({
        mutationKey: ["populateAgentBlock", chatId] as const,
        mutationFn: async ({
            messageSetId,
            agentType,
            sessionId,
            userPrompt,
        }: {
            messageSetId: string;
            agentType: AgentType;
            sessionId?: string;
            userPrompt: string;
        }) => {
            const modelId = getAgentModelId(agentType);

            // Create the AI message
            const messageId = uuidv4().replace(/-/g, "").toLowerCase();

            await db.execute(
                `INSERT INTO messages (id, chat_id, message_set_id, text, model, selected, state, block_type)
                 VALUES (?, ?, ?, '', ?, 1, 'streaming', 'tools')`,
                [messageId, chatId, messageSetId, modelId],
            );

            // Run the agent task
            await runAgentTask.mutateAsync({
                chatId,
                messageId,
                messageSetId,
                prompt: userPrompt,
                agentType,
                sessionId,
            });

            return { messageId };
        },
    });
}

/**
 * Hook to stop a running agent task
 */
export function useStopAgentTask() {
    return useMutation({
        mutationKey: ["stopAgentTask"] as const,
        mutationFn: async ({ chatId }: { chatId: string }) => {
            await agentRunner.stopTask(chatId);
        },
    });
}

/**
 * Hook to end an agent session (stop container)
 */
export function useEndAgentSession() {
    const queryClient = useQueryClient();
    const updateAgentSession = useUpdateAgentSession();

    return useMutation({
        mutationKey: ["endAgentSession"] as const,
        mutationFn: async ({ chatId }: { chatId: string }) => {
            await agentRunner.endSession(chatId);

            // Clear session info in database
            await updateAgentSession.mutateAsync({
                chatId,
                sessionId: undefined,
                containerId: undefined,
            });
        },
        onSuccess: (_data, variables) => {
            void queryClient.invalidateQueries(
                chatQueries.detail(variables.chatId),
            );
        },
    });
}

/**
 * Hook to check agent availability status
 */
export function useAgentAvailability(agentType: AgentType) {
    return useMutation({
        mutationKey: ["checkAgentAvailability", agentType] as const,
        mutationFn: async () => {
            return agentRunner.checkAgentAvailability(agentType);
        },
    });
}

/**
 * Get the folder path for an agent chat
 */
export function useGetAgentFolderPath() {
    return useMutation({
        mutationKey: ["getAgentFolderPath"] as const,
        mutationFn: async ({ chatId }: { chatId: string }) => {
            return containerManager.getAgentFolderPath(chatId);
        },
    });
}
