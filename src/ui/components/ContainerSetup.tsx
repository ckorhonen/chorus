/**
 * ContainerSetup - First-time setup flow for agent container environment
 *
 * Guides users through:
 * 1. Installing Apple Container CLI (if not installed)
 * 2. Starting the container service
 * 3. Building the chorus-agent-image
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "./ui/dialog";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import {
    CheckCircleIcon,
    XCircleIcon,
    Loader2Icon,
    ExternalLinkIcon,
    TerminalIcon,
    BoxIcon,
    PlayIcon,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
    containerManager,
    ContainerStatus,
} from "@core/chorus/ContainerManager";
import { cn } from "@ui/lib/utils";

interface ContainerSetupProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onComplete?: () => void;
}

type SetupStep = "check" | "install" | "start-service" | "build-image" | "complete";

interface StepState {
    status: "pending" | "in-progress" | "complete" | "error";
    message?: string;
}

const CONTAINER_CLI_URL = "https://github.com/apple/container";
const DOCKERFILE_PATH = "assets/Dockerfile.agent";

function StepIndicator({
    step,
    label,
    state,
}: {
    step: number;
    label: string;
    state: StepState;
}) {
    return (
        <div className="flex items-center gap-3 py-2">
            <div
                className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium",
                    state.status === "complete" && "bg-green-500 text-white",
                    state.status === "in-progress" && "bg-primary text-primary-foreground",
                    state.status === "pending" && "bg-muted text-muted-foreground",
                    state.status === "error" && "bg-destructive text-destructive-foreground",
                )}
            >
                {state.status === "complete" ? (
                    <CheckCircleIcon className="w-4 h-4" />
                ) : state.status === "in-progress" ? (
                    <Loader2Icon className="w-4 h-4 animate-spin" />
                ) : state.status === "error" ? (
                    <XCircleIcon className="w-4 h-4" />
                ) : (
                    step
                )}
            </div>
            <div className="flex-1">
                <div className="text-sm font-medium">{label}</div>
                {state.message && (
                    <div
                        className={cn(
                            "text-xs",
                            state.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground",
                        )}
                    >
                        {state.message}
                    </div>
                )}
            </div>
        </div>
    );
}

export function ContainerSetup({ open, onOpenChange, onComplete }: ContainerSetupProps) {
    const [currentStep, setCurrentStep] = useState<SetupStep>("check");
    const [steps, setSteps] = useState<Record<string, StepState>>({
        cli: { status: "pending" },
        service: { status: "pending" },
        image: { status: "pending" },
    });
    const [buildProgress, setBuildProgress] = useState<string[]>([]);
    const [containerStatus, setContainerStatus] = useState<ContainerStatus>("ready");

    // Check current status when dialog opens
    useEffect(() => {
        if (open) {
            void checkStatus();
        }
    }, [open]);

    const checkStatus = async () => {
        setCurrentStep("check");
        const status = await containerManager.checkStatus();
        setContainerStatus(status);

        if (status === "not_installed") {
            setSteps({
                cli: { status: "pending", message: "Not installed" },
                service: { status: "pending" },
                image: { status: "pending" },
            });
            setCurrentStep("install");
        } else if (status === "service_stopped") {
            setSteps({
                cli: { status: "complete", message: "Installed" },
                service: { status: "pending", message: "Not running" },
                image: { status: "pending" },
            });
            setCurrentStep("start-service");
        } else if (status === "image_missing") {
            setSteps({
                cli: { status: "complete", message: "Installed" },
                service: { status: "complete", message: "Running" },
                image: { status: "pending", message: "Not built" },
            });
            setCurrentStep("build-image");
        } else {
            setSteps({
                cli: { status: "complete", message: "Installed" },
                service: { status: "complete", message: "Running" },
                image: { status: "complete", message: "Ready" },
            });
            setCurrentStep("complete");
            onComplete?.();
        }
    };

    const handleStartService = async () => {
        setSteps((prev) => ({
            ...prev,
            service: { status: "in-progress", message: "Starting..." },
        }));

        try {
            await containerManager.startService();
            setSteps((prev) => ({
                ...prev,
                service: { status: "complete", message: "Running" },
            }));

            // Check if image exists
            const imageExists = await containerManager.imageExists("chorus-agent-image");
            if (imageExists) {
                setSteps((prev) => ({
                    ...prev,
                    image: { status: "complete", message: "Ready" },
                }));
                setCurrentStep("complete");
                onComplete?.();
            } else {
                setCurrentStep("build-image");
            }
        } catch (error) {
            setSteps((prev) => ({
                ...prev,
                service: {
                    status: "error",
                    message: error instanceof Error ? error.message : "Failed to start",
                },
            }));
        }
    };

    const handleBuildImage = async () => {
        setSteps((prev) => ({
            ...prev,
            image: { status: "in-progress", message: "Building..." },
        }));
        setBuildProgress([]);

        try {
            await containerManager.buildAgentImage(DOCKERFILE_PATH, (line) => {
                setBuildProgress((prev) => [...prev.slice(-20), line]);
            });

            setSteps((prev) => ({
                ...prev,
                image: { status: "complete", message: "Ready" },
            }));
            setCurrentStep("complete");
            onComplete?.();
        } catch (error) {
            setSteps((prev) => ({
                ...prev,
                image: {
                    status: "error",
                    message: error instanceof Error ? error.message : "Build failed",
                },
            }));
        }
    };

    const handleOpenContainerDocs = () => {
        void openUrl(CONTAINER_CLI_URL);
    };

    const handleRetry = () => {
        void checkStatus();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <BoxIcon className="w-5 h-5" />
                        Agent Container Setup
                    </DialogTitle>
                    <DialogDescription>
                        Set up the container environment to run AI coding agents securely.
                    </DialogDescription>
                </DialogHeader>

                <div className="py-4 space-y-1">
                    <StepIndicator step={1} label="Container CLI" state={steps.cli} />
                    <StepIndicator step={2} label="Container Service" state={steps.service} />
                    <StepIndicator step={3} label="Agent Image" state={steps.image} />
                </div>

                {/* Step-specific content */}
                {currentStep === "check" && (
                    <div className="flex items-center justify-center py-4">
                        <Loader2Icon className="w-6 h-6 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-sm text-muted-foreground">
                            Checking system status...
                        </span>
                    </div>
                )}

                {currentStep === "install" && (
                    <div className="space-y-4">
                        <div className="p-4 bg-muted rounded-lg">
                            <h4 className="text-sm font-medium mb-2">Install Apple Container CLI</h4>
                            <p className="text-xs text-muted-foreground mb-3">
                                The Apple Container CLI is required to run agents in isolated
                                environments. macOS 26 or later is required.
                            </p>
                            <div className="bg-background rounded p-2 font-mono text-xs mb-3">
                                brew install apple/container/container
                            </div>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleOpenContainerDocs}
                                className="text-xs"
                            >
                                <ExternalLinkIcon className="w-3 h-3 mr-1" />
                                View Installation Guide
                            </Button>
                        </div>
                        <Button onClick={handleRetry} className="w-full">
                            I've Installed It
                        </Button>
                    </div>
                )}

                {currentStep === "start-service" && (
                    <div className="space-y-4">
                        <div className="p-4 bg-muted rounded-lg">
                            <h4 className="text-sm font-medium mb-2">Start Container Service</h4>
                            <p className="text-xs text-muted-foreground">
                                The container service needs to be running to create agent
                                environments.
                            </p>
                        </div>
                        <Button
                            onClick={() => void handleStartService()}
                            disabled={steps.service.status === "in-progress"}
                            className="w-full"
                        >
                            {steps.service.status === "in-progress" ? (
                                <>
                                    <Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
                                    Starting...
                                </>
                            ) : (
                                <>
                                    <PlayIcon className="w-4 h-4 mr-2" />
                                    Start Service
                                </>
                            )}
                        </Button>
                    </div>
                )}

                {currentStep === "build-image" && (
                    <div className="space-y-4">
                        <div className="p-4 bg-muted rounded-lg">
                            <h4 className="text-sm font-medium mb-2">Build Agent Image</h4>
                            <p className="text-xs text-muted-foreground mb-2">
                                Building the container image with Node.js, Python, and agent CLIs.
                                This may take a few minutes.
                            </p>
                            {buildProgress.length > 0 && (
                                <div className="bg-background rounded p-2 font-mono text-xs max-h-32 overflow-y-auto">
                                    {buildProgress.map((line, i) => (
                                        <div key={i} className="text-muted-foreground">
                                            {line}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <Button
                            onClick={() => void handleBuildImage()}
                            disabled={steps.image.status === "in-progress"}
                            className="w-full"
                        >
                            {steps.image.status === "in-progress" ? (
                                <>
                                    <Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
                                    Building...
                                </>
                            ) : (
                                <>
                                    <BoxIcon className="w-4 h-4 mr-2" />
                                    Build Image
                                </>
                            )}
                        </Button>
                    </div>
                )}

                {currentStep === "complete" && (
                    <div className="space-y-4">
                        <div className="p-4 bg-green-50 dark:bg-green-950/20 rounded-lg text-center">
                            <CheckCircleIcon className="w-8 h-8 mx-auto mb-2 text-green-500" />
                            <h4 className="text-sm font-medium text-green-700 dark:text-green-400">
                                Setup Complete!
                            </h4>
                            <p className="text-xs text-green-600 dark:text-green-500 mt-1">
                                Your container environment is ready for AI agents.
                            </p>
                        </div>
                        <Button
                            onClick={() => onOpenChange(false)}
                            className="w-full"
                        >
                            Get Started
                        </Button>
                    </div>
                )}

                {/* Error state */}
                {(steps.cli.status === "error" ||
                    steps.service.status === "error" ||
                    steps.image.status === "error") && (
                    <DialogFooter>
                        <Button variant="outline" onClick={handleRetry}>
                            Retry
                        </Button>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * Hook to check if container setup is needed
 */
export function useContainerSetupNeeded() {
    const [needed, setNeeded] = useState<boolean | null>(null);
    const [status, setStatus] = useState<ContainerStatus>("ready");

    useEffect(() => {
        const check = async () => {
            const s = await containerManager.checkStatus();
            setStatus(s);
            setNeeded(s !== "ready");
        };
        void check();
    }, []);

    return { needed, status };
}
