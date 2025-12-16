/**
 * AgentChatHeader - Controls and status display for agent mode chats
 *
 * Shows:
 * - Agent type selector (Codex/Claude)
 * - Linked folder path with "Open in Finder" button
 * - Container status indicator
 * - Stop/Start controls
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./ui/select";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
    FolderOpenIcon,
    PlayIcon,
    StopCircleIcon,
    BotIcon,
    AlertCircleIcon,
    CheckCircleIcon,
    Loader2Icon,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentType, Chat } from "@core/chorus/api/ChatAPI";
import {
    useSetAgentEnabled,
    useSetAgentType,
    useUpdateAgentSession,
} from "@core/chorus/api/ChatAPI";
import {
    containerManager,
    ContainerStatus,
    ContainerRunStatus,
} from "@core/chorus/ContainerManager";
import { agentRunner } from "@core/chorus/AgentRunner";
import { cn } from "@ui/lib/utils";

interface AgentChatHeaderProps {
    chat: Chat;
    onSetupRequired?: () => void;
}

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
    codex: "Codex CLI",
    claude: "Claude Code",
};

function StatusBadge({
    status,
    containerStatus,
}: {
    status: "idle" | "running" | "error";
    containerStatus: ContainerStatus;
}) {
    if (containerStatus !== "ready") {
        const statusConfig: Record<
            ContainerStatus,
            { label: string; variant: "destructive" | "secondary"; icon: React.ReactNode }
        > = {
            not_installed: {
                label: "Container CLI Missing",
                variant: "destructive",
                icon: <AlertCircleIcon className="w-3 h-3 mr-1" />,
            },
            service_stopped: {
                label: "Service Stopped",
                variant: "secondary",
                icon: <AlertCircleIcon className="w-3 h-3 mr-1" />,
            },
            image_missing: {
                label: "Image Not Built",
                variant: "secondary",
                icon: <AlertCircleIcon className="w-3 h-3 mr-1" />,
            },
            ready: {
                label: "Ready",
                variant: "secondary",
                icon: <CheckCircleIcon className="w-3 h-3 mr-1" />,
            },
        };

        const config = statusConfig[containerStatus];
        return (
            <Badge variant={config.variant} className="text-xs">
                {config.icon}
                {config.label}
            </Badge>
        );
    }

    const runStatusConfig: Record<
        "idle" | "running" | "error",
        { label: string; variant: "default" | "secondary" | "destructive"; icon: React.ReactNode }
    > = {
        idle: {
            label: "Idle",
            variant: "secondary",
            icon: <CheckCircleIcon className="w-3 h-3 mr-1" />,
        },
        running: {
            label: "Running",
            variant: "default",
            icon: <Loader2Icon className="w-3 h-3 mr-1 animate-spin" />,
        },
        error: {
            label: "Error",
            variant: "destructive",
            icon: <AlertCircleIcon className="w-3 h-3 mr-1" />,
        },
    };

    const config = runStatusConfig[status];
    return (
        <Badge variant={config.variant} className="text-xs">
            {config.icon}
            {config.label}
        </Badge>
    );
}

export function AgentChatHeader({ chat, onSetupRequired }: AgentChatHeaderProps) {
    const [containerStatus, setContainerStatus] = useState<ContainerStatus>("ready");
    const [agentStatus, setAgentStatus] = useState<"idle" | "running" | "error">("idle");
    const [folderPath, setFolderPath] = useState<string | undefined>(chat.agentFolderPath);

    const setAgentEnabled = useSetAgentEnabled();
    const setAgentType = useSetAgentType();
    const updateAgentSession = useUpdateAgentSession();

    // Check container status on mount
    useEffect(() => {
        const checkStatus = async () => {
            const status = await containerManager.checkStatus();
            setContainerStatus(status);
        };
        void checkStatus();
    }, []);

    // Get folder path if not set
    useEffect(() => {
        if (!folderPath && chat.id) {
            void containerManager.getAgentFolderPath(chat.id).then(setFolderPath);
        }
    }, [chat.id, folderPath]);

    // Check if agent is running
    useEffect(() => {
        const isRunning = agentRunner.isRunning(chat.id);
        setAgentStatus(isRunning ? "running" : "idle");
    }, [chat.id]);

    const handleAgentTypeChange = useCallback(
        async (value: string) => {
            const agentType = value as AgentType;
            await setAgentType.mutateAsync({
                chatId: chat.id,
                agentType,
            });
        },
        [chat.id, setAgentType],
    );

    const handleOpenFolder = useCallback(async () => {
        if (folderPath) {
            await openPath(folderPath);
        }
    }, [folderPath]);

    const handleStopAgent = useCallback(async () => {
        await agentRunner.stopTask(chat.id);
        setAgentStatus("idle");
    }, [chat.id]);

    const handleDisableAgent = useCallback(async () => {
        // Stop any running tasks and end session
        await agentRunner.endSession(chat.id);

        // Clear agent settings in database
        await setAgentEnabled.mutateAsync({
            chatId: chat.id,
            enabled: false,
        });
    }, [chat.id, setAgentEnabled]);

    // If container is not ready, show setup prompt
    if (containerStatus !== "ready" && onSetupRequired) {
        return (
            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b">
                <BotIcon className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Agent Mode</span>
                <StatusBadge status={agentStatus} containerStatus={containerStatus} />
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={onSetupRequired}
                    className="ml-auto"
                >
                    Setup Required
                </Button>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3 px-3 py-2 bg-muted/50 border-b">
            {/* Agent icon and label */}
            <div className="flex items-center gap-2">
                <BotIcon className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">Agent Mode</span>
            </div>

            {/* Agent type selector */}
            <Select
                value={chat.agentType ?? "codex"}
                onValueChange={(v) => void handleAgentTypeChange(v)}
            >
                <SelectTrigger className="w-[140px] h-7 text-xs">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="codex">{AGENT_TYPE_LABELS.codex}</SelectItem>
                    <SelectItem value="claude">{AGENT_TYPE_LABELS.claude}</SelectItem>
                </SelectContent>
            </Select>

            {/* Status badge */}
            <StatusBadge status={agentStatus} containerStatus={containerStatus} />

            {/* Spacer */}
            <div className="flex-1" />

            {/* Folder path and open button */}
            {folderPath && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleOpenFolder()}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                        >
                            <FolderOpenIcon className="w-3.5 h-3.5 mr-1.5" />
                            <span className="max-w-[200px] truncate">
                                {folderPath.split("/").slice(-2).join("/")}
                            </span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                        <p>Open folder: {folderPath}</p>
                    </TooltipContent>
                </Tooltip>
            )}

            {/* Stop button (when running) */}
            {agentStatus === "running" && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void handleStopAgent()}
                            className="h-7 px-2"
                        >
                            <StopCircleIcon className="w-3.5 h-3.5 mr-1" />
                            Stop
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop the running agent task</TooltipContent>
                </Tooltip>
            )}

            {/* Disable agent mode button */}
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDisableAgent()}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                        Disable
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Disable agent mode for this chat</TooltipContent>
            </Tooltip>
        </div>
    );
}

/**
 * Toggle button to enable agent mode on a chat
 */
export function AgentModeToggle({
    chat,
    onEnable,
}: {
    chat: Chat;
    onEnable?: () => void;
}) {
    const setAgentEnabled = useSetAgentEnabled();
    const [isEnabling, setIsEnabling] = useState(false);

    const handleEnable = useCallback(async () => {
        setIsEnabling(true);
        try {
            // Create folder path
            const folderPath = await containerManager.getAgentFolderPath(chat.id);

            // Enable agent mode with default type (codex)
            await setAgentEnabled.mutateAsync({
                chatId: chat.id,
                enabled: true,
                agentType: "codex",
                folderPath,
            });

            onEnable?.();
        } catch (error) {
            console.error("Failed to enable agent mode:", error);
        } finally {
            setIsEnabling(false);
        }
    }, [chat.id, setAgentEnabled, onEnable]);

    if (chat.agentEnabled) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleEnable()}
                    disabled={isEnabling}
                    className="h-7 px-2 text-xs"
                >
                    {isEnabling ? (
                        <Loader2Icon className="w-3.5 h-3.5 mr-1 animate-spin" />
                    ) : (
                        <BotIcon className="w-3.5 h-3.5 mr-1" />
                    )}
                    Enable Agent
                </Button>
            </TooltipTrigger>
            <TooltipContent>
                <p>Enable AI coding agent for this chat</p>
            </TooltipContent>
        </Tooltip>
    );
}
