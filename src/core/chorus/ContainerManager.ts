/**
 * ContainerManager - Manages Apple Container service for agent sandboxing
 *
 * Uses the Apple `container` CLI (macOS 26+) to run agents in isolated micro-VMs.
 */

import { Command } from "@tauri-apps/plugin-shell";
import { homeDir } from "@tauri-apps/api/path";

const AGENT_IMAGE_NAME = "chorus-agent-image";
const AGENT_CHATS_DIR = "Chorus/agent-chats";

export type ContainerStatus =
    | "not_installed"
    | "service_stopped"
    | "image_missing"
    | "ready";

export type ContainerRunStatus = "stopped" | "starting" | "running" | "error";

interface ContainerInfo {
    id: string;
    name: string;
    status: ContainerRunStatus;
}

/**
 * Execute a container CLI command and return the output
 */
async function runContainerCommand(
    args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const command = Command.create("container", args);
    const output = await command.execute();
    return {
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: output.code ?? 0,
    };
}

/**
 * Check if a command exists on the system
 */
async function commandExists(cmd: string): Promise<boolean> {
    try {
        const command = Command.create("which", [cmd]);
        const output = await command.execute();
        return output.code === 0;
    } catch {
        return false;
    }
}

export class ContainerManager {
    private static _instance: ContainerManager | undefined;

    static get instance(): ContainerManager {
        if (!ContainerManager._instance) {
            ContainerManager._instance = new ContainerManager();
        }
        return ContainerManager._instance;
    }

    /**
     * Check the overall status of the container system
     */
    async checkStatus(): Promise<ContainerStatus> {
        // Check if container CLI is installed
        const installed = await commandExists("container");
        if (!installed) {
            return "not_installed";
        }

        // Check if container service is running by listing containers
        try {
            const result = await runContainerCommand(["ls"]);
            if (result.exitCode !== 0) {
                // Service might not be running
                return "service_stopped";
            }
        } catch {
            return "service_stopped";
        }

        // Check if our agent image exists
        const imageExists = await this.imageExists(AGENT_IMAGE_NAME);
        if (!imageExists) {
            return "image_missing";
        }

        return "ready";
    }

    /**
     * Start the container service
     */
    async startService(): Promise<void> {
        const result = await runContainerCommand(["system", "start"]);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to start container service: ${result.stderr}`);
        }
    }

    /**
     * Stop the container service
     */
    async stopService(): Promise<void> {
        const result = await runContainerCommand(["system", "stop"]);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to stop container service: ${result.stderr}`);
        }
    }

    /**
     * Check if an image exists
     */
    async imageExists(imageName: string): Promise<boolean> {
        try {
            const result = await runContainerCommand(["images", "list"]);
            return result.stdout.includes(imageName);
        } catch {
            return false;
        }
    }

    /**
     * Build the agent dev container image
     */
    async buildAgentImage(
        dockerfilePath: string,
        onProgress?: (line: string) => void,
    ): Promise<void> {
        const command = Command.create("container", [
            "build",
            "--tag",
            AGENT_IMAGE_NAME,
            "--file",
            dockerfilePath,
            ".",
        ]);

        return new Promise((resolve, reject) => {
            let stderr = "";

            command.stdout.on("data", (line) => {
                onProgress?.(line);
            });

            command.stderr.on("data", (line) => {
                stderr += line;
                onProgress?.(line);
            });

            command.on("close", (data) => {
                if (data.code === 0) {
                    resolve();
                } else {
                    reject(new Error(`Failed to build image: ${stderr}`));
                }
            });

            command.on("error", (error) => {
                reject(new Error(`Build error: ${error}`));
            });

            command.spawn();
        });
    }

    /**
     * Get the folder path for a chat's agent workspace
     */
    async getAgentFolderPath(chatId: string): Promise<string> {
        const home = await homeDir();
        return `${home}${AGENT_CHATS_DIR}/${chatId}`;
    }

    /**
     * Create the agent folder for a chat if it doesn't exist
     */
    async ensureAgentFolder(chatId: string): Promise<string> {
        const folderPath = await this.getAgentFolderPath(chatId);

        // Create directory using mkdir -p
        const command = Command.create("mkdir", ["-p", folderPath]);
        const result = await command.execute();

        if (result.code !== 0) {
            throw new Error(`Failed to create agent folder: ${result.stderr}`);
        }

        return folderPath;
    }

    /**
     * Start a container for a specific chat
     */
    async startContainer(
        chatId: string,
        folderPath: string,
    ): Promise<string> {
        const containerName = `chorus-agent-${chatId}`;

        // Check if container already exists
        const existing = await this.getContainer(containerName);
        if (existing) {
            if (existing.status === "running") {
                return containerName;
            }
            // Stop and remove existing container
            await this.stopContainer(containerName);
        }

        // Start new container with volume mount
        const result = await runContainerCommand([
            "run",
            "--name",
            containerName,
            "--volume",
            `${folderPath}:/app`,
            "--detach",
            AGENT_IMAGE_NAME,
        ]);

        if (result.exitCode !== 0) {
            throw new Error(`Failed to start container: ${result.stderr}`);
        }

        return containerName;
    }

    /**
     * Execute a command inside a container and stream output
     */
    async *exec(
        containerName: string,
        command: string[],
    ): AsyncIterable<string> {
        const containerCommand = Command.create("container", [
            "exec",
            containerName,
            ...command,
        ]);

        const process = await containerCommand.spawn();

        // Create a queue for output lines
        const outputQueue: string[] = [];
        let done = false;
        let error: Error | undefined;

        containerCommand.stdout.on("data", (line) => {
            outputQueue.push(line);
        });

        containerCommand.stderr.on("data", (line) => {
            outputQueue.push(line);
        });

        containerCommand.on("close", (_data) => {
            done = true;
        });

        containerCommand.on("error", (err) => {
            error = new Error(err);
            done = true;
        });

        // Yield output lines as they come in
        while (!done || outputQueue.length > 0) {
            if (outputQueue.length > 0) {
                yield outputQueue.shift()!;
            } else {
                // Wait a bit for more output
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }

        if (error) {
            throw error;
        }

        // Clean up
        await process.kill();
    }

    /**
     * Execute a command inside a container and wait for completion
     */
    async execSync(
        containerName: string,
        command: string[],
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        const result = await runContainerCommand([
            "exec",
            containerName,
            ...command,
        ]);
        return result;
    }

    /**
     * Stop a container
     */
    async stopContainer(containerName: string): Promise<void> {
        const result = await runContainerCommand(["stop", containerName]);
        if (result.exitCode !== 0 && !result.stderr.includes("not found")) {
            throw new Error(`Failed to stop container: ${result.stderr}`);
        }
    }

    /**
     * Get info about a specific container
     */
    async getContainer(containerName: string): Promise<ContainerInfo | undefined> {
        try {
            const result = await runContainerCommand(["ls"]);
            const lines = result.stdout.split("\n");

            for (const line of lines) {
                if (line.includes(containerName)) {
                    return {
                        id: containerName,
                        name: containerName,
                        status: line.includes("running") ? "running" : "stopped",
                    };
                }
            }
        } catch {
            return undefined;
        }
        return undefined;
    }

    /**
     * List all chorus agent containers
     */
    async listAgentContainers(): Promise<ContainerInfo[]> {
        try {
            const result = await runContainerCommand(["ls"]);
            const lines = result.stdout.split("\n");
            const containers: ContainerInfo[] = [];

            for (const line of lines) {
                if (line.includes("chorus-agent-")) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        containers.push({
                            id: parts[0],
                            name: parts[1],
                            status: line.includes("running") ? "running" : "stopped",
                        });
                    }
                }
            }

            return containers;
        } catch {
            return [];
        }
    }

    /**
     * Stop all chorus agent containers
     */
    async stopAllAgentContainers(): Promise<void> {
        const containers = await this.listAgentContainers();
        await Promise.all(
            containers.map((c) => this.stopContainer(c.name)),
        );
    }

    /**
     * Ensure the container service is running and ready
     */
    async ensureServiceRunning(): Promise<void> {
        const status = await this.checkStatus();

        if (status === "not_installed") {
            throw new Error(
                "Apple Container CLI is not installed. Please install it from https://github.com/apple/container",
            );
        }

        if (status === "service_stopped") {
            await this.startService();
        }
    }

    /**
     * Ensure the agent image exists, build if needed
     */
    async ensureAgentImage(
        dockerfilePath: string,
        onProgress?: (line: string) => void,
    ): Promise<void> {
        const exists = await this.imageExists(AGENT_IMAGE_NAME);
        if (!exists) {
            await this.buildAgentImage(dockerfilePath, onProgress);
        }
    }
}

// Export singleton instance
export const containerManager = ContainerManager.instance;
