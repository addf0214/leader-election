import { CoordinationV1Api, KubeConfig, V1Lease, V1MicroTime, Watch } from "@kubernetes/client-node";
import { EventEmitter } from "events";

export interface Logger {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

const defaultLogger: Logger = {
    debug: () => {},
    info: () => {},
    error: (...args: any[]) => {
        console.error(...args);
    },
};

export class LeaderElectionService {
    private kubeClient: CoordinationV1Api;
    private watch: Watch;
    private leaseName: string;
    private namespace: string;
    private renewalInterval: number;
    private durationInSeconds: number;
    private isLeader = false;
    private leaseRenewalTimeout: NodeJS.Timeout | null = null;
    private notLeaderRetryTimeout: NodeJS.Timeout | null = null;
    private awaitLeadership: boolean;
    private readonly eventEmitter: EventEmitter;
    private readonly logger: Logger;
    LEADER_IDENTITY = `${process.env.HOSTNAME}`;

    constructor(options: { leaseName?: string; namespace?: string; renewalInterval?: number; awaitLeadership?: boolean; logger?: Logger }) {
        this.logger = options.logger ?? defaultLogger;
        const kubeConfig = new KubeConfig();
        if (process.env.KUBERNETES_SERVICE_HOST) {
            kubeConfig.loadFromDefault();
            this.kubeClient = kubeConfig.makeApiClient(CoordinationV1Api);
            this.watch = new Watch(kubeConfig);
        } else {
            this.logger.info("Not running in Kubernetes environment. Leader election will be simulated.");
            this.kubeClient = null as any;
            this.watch = null as any;
        }

        this.leaseName = options.leaseName ?? "leader-election";
        this.namespace = options.namespace ?? process.env.NAMESPACE ?? "default";
        this.renewalInterval = options.renewalInterval ?? 10000;
        this.durationInSeconds = 2 * (this.renewalInterval / 1000);
        this.awaitLeadership = options.awaitLeadership ?? false;
        this.eventEmitter = new EventEmitter();

        process.on("SIGINT", () => this.gracefulShutdown());
        process.on("SIGTERM", () => this.gracefulShutdown());
    }

    async initialize() {
        if (!process.env.KUBERNETES_SERVICE_HOST) {
            this.logger.info("Not running in Kubernetes, assuming leadership...");
            process.nextTick(() => {
                this.isLeader = true;
                this.emitLeaderElectedEvent();
            });
        } else {
            this.watchLeaseObject();

            if (this.awaitLeadership) {
                await this.runLeaderElectionProcess();
            } else {
                this.runLeaderElectionProcess().catch((error) => {
                    this.logger.error({
                        message: "Leader election process failed",
                        error,
                    });
                });
            }
        }
    }

    public on(event: "leaderElected" | "leaderLost", listener: (...args: any[]) => void): void {
        this.eventEmitter.on(event, listener);
    }

    private async runLeaderElectionProcess() {
        if (this.isLeader) return;
        await this.tryToBecomeLeader();
        this.scheduleNotLeaderRetry();
    }

    private async tryToBecomeLeader() {
        this.logger.info("Trying to become leader...");
        try {
            let lease: V1Lease = await this.getLease();
            if (this.isLeaseExpired(lease) || !lease.spec?.holderIdentity) {
                this.logger.info("Lease expired or not held. Attempting to become leader...");
                lease = await this.acquireLease(lease);
            }
            if (this.isLeaseHeldByUs(lease)) {
                this.becomeLeader();
            }
        } catch (error) {
            this.logger.error({
                message: "Error while trying to become leader",
                error,
            });
        }
    }

    private async acquireLease(lease: V1Lease): Promise<V1Lease> {
        if (!lease.spec) {
            lease.spec = {};
        }
        lease.spec.holderIdentity = this.LEADER_IDENTITY;
        lease.spec.leaseDurationSeconds = this.durationInSeconds;
        lease.spec.acquireTime = new V1MicroTime(new Date());
        lease.spec.renewTime = new V1MicroTime(new Date());

        try {
            const { body } = await this.kubeClient.replaceNamespacedLease(this.leaseName, this.namespace, lease);
            this.logger.info("Successfully acquired lease");
            return body;
        } catch (error) {
            this.logger.error({ message: "Error while acquiring lease", error });
            throw error;
        }
    }

    private async renewLease() {
        try {
            let lease: V1Lease = await this.getLease();
            if (this.isLeaseHeldByUs(lease)) {
                this.logger.debug("Renewing lease...");
                lease.spec!.renewTime = new V1MicroTime(new Date());
                try {
                    const { body } = await this.kubeClient.replaceNamespacedLease(this.leaseName, this.namespace, lease);
                    this.logger.debug("Successfully renewed lease");
                    return body;
                } catch (error) {
                    this.logger.error({ message: "Error while renewing lease", error });
                    throw error;
                }
            } else {
                this.loseLeadership();
            }
        } catch (error) {
            this.logger.error({ message: "Error while renewing lease", error });
            this.loseLeadership();
        }
    }

    private async getLease(): Promise<V1Lease> {
        try {
            const { body } = await this.kubeClient.readNamespacedLease(this.leaseName, this.namespace);
            return body;
        } catch (error) {
            if (error instanceof Error && (error as any).response?.statusCode === 404) {
                this.logger.info("Lease not found. Creating lease...");
                return this.createLease();
            } else {
                throw error;
            }
        }
    }

    private async createLease(): Promise<V1Lease> {
        const lease = {
            metadata: {
                name: this.leaseName,
                namespace: this.namespace,
            },
            spec: {
                holderIdentity: this.LEADER_IDENTITY,
                leaseDurationSeconds: this.durationInSeconds,
                acquireTime: new V1MicroTime(new Date()),
                renewTime: new V1MicroTime(new Date()),
            },
        };

        try {
            const { body } = await this.kubeClient.createNamespacedLease(this.namespace, lease);
            this.logger.info("Successfully created lease");
            return body;
        } catch (error) {
            this.logger.error({ message: "Failed to create lease", error });
            throw error;
        }
    }

    private isLeaseExpired(lease: V1Lease): boolean {
        const renewTime = lease.spec!.renewTime ? new Date(lease.spec!.renewTime).getTime() : 0;
        const leaseDurationMs = (lease.spec!.leaseDurationSeconds || this.durationInSeconds) * 1000;
        return Date.now() > renewTime + leaseDurationMs;
    }

    private isLeaseHeldByUs(lease: V1Lease): boolean {
        return lease.spec!.holderIdentity === this.LEADER_IDENTITY;
    }

    private async gracefulShutdown() {
        this.logger.info("Graceful shutdown initiated");
        if (this.isLeader) {
            await this.releaseLease();
        }
    }

    private async releaseLease(): Promise<void> {
        try {
            let lease = await this.getLease();
            if (lease && this.isLeaseHeldByUs(lease)) {
                lease.spec!.holderIdentity = undefined;
                lease.spec!.renewTime = undefined;
                await this.kubeClient.replaceNamespacedLease(this.leaseName, this.namespace, lease);
                this.logger.info(`Lease for ${this.leaseName} released.`);
            }
        } catch (error) {
            this.logger.error({ message: "Failed to release lease", error });
        }
    }

    private emitLeaderElectedEvent() {
        this.eventEmitter.emit("leaderElected", { leaseName: this.leaseName });
        this.logger.info(`Instance became the leader for lease: ${this.leaseName}`);
    }

    private emitLeadershipLostEvent() {
        this.eventEmitter.emit("leaderLost", { leaseName: this.leaseName });
        this.logger.info(`Instance lost the leadership for lease: ${this.leaseName}`);
    }

    private becomeLeader() {
        this.isLeader = true;
        this.emitLeaderElectedEvent();
        this.scheduleLeaseRenewal();
        if (this.notLeaderRetryTimeout) {
            clearTimeout(this.notLeaderRetryTimeout);
            this.notLeaderRetryTimeout = null;
        }
    }

    private loseLeadership() {
        if (this.isLeader) {
            this.isLeader = false;
            if (this.leaseRenewalTimeout) {
                clearTimeout(this.leaseRenewalTimeout);
                this.leaseRenewalTimeout = null;
            }
            this.emitLeadershipLostEvent();
            this.scheduleNotLeaderRetry();
        }
    }

    private scheduleNotLeaderRetry() {
        if (this.isLeader) return;
        if (this.notLeaderRetryTimeout) {
            clearTimeout(this.notLeaderRetryTimeout);
        }
        this.notLeaderRetryTimeout = setTimeout(async () => {
            if (!this.isLeader) {
                await this.tryToBecomeLeader();
                this.scheduleNotLeaderRetry();
            }
        }, this.renewalInterval);
    }

    private async watchLeaseObject() {
        const path = `/apis/coordination.k8s.io/v1/namespaces/${this.namespace}/leases`;
        try {
            await this.watch.watch(
                path,
                {},
                (type, apiObj) => {
                    if (apiObj && apiObj.metadata.name === this.leaseName) {
                        this.logger.debug(`Watch event type: ${type} for lease: ${this.leaseName}`);
                        switch (type) {
                            case "ADDED":
                            case "MODIFIED":
                                setTimeout(() => this.handleLeaseUpdate(apiObj), 2000);
                                break;
                            case "DELETED":
                                setTimeout(() => this.handleLeaseDeletion(), 2000);
                                break;
                        }
                    }
                },
                (err) => {
                    if (err) {
                        this.logger.error({
                            message: `Watch for lease ended with error: ${err}, trying again in 5 seconds`,
                            error: err,
                        });
                    } else {
                        this.logger.info("Watch for lease gracefully closed");
                    }
                    setTimeout(() => this.watchLeaseObject(), 5000);
                }
            );
        } catch (err) {
            this.logger.error(`Failed to start watch for lease: ${err}, trying again in 5 seconds`);
            setTimeout(() => this.watchLeaseObject(), 5000);
        }
    }

    private scheduleLeaseRenewal() {
        if (this.leaseRenewalTimeout) {
            clearTimeout(this.leaseRenewalTimeout);
        }

        this.leaseRenewalTimeout = setTimeout(async () => {
            if (this.isLeader) {
                try {
                    await this.renewLease();
                } catch (error) {
                    this.logger.error({ message: "Error while renewing lease", error });
                }
            }
        }, this.renewalInterval);
    }

    private handleLeaseUpdate(leaseObj: V1Lease) {
        if (this.isLeaseHeldByUs(leaseObj)) {
            if (!this.isLeader) {
                setTimeout(() => {
                    this.becomeLeader();
                }, 2000);
            }
            this.scheduleLeaseRenewal();
        } else if (!leaseObj.spec?.holderIdentity) {
            this.tryToBecomeLeader();
        } else if (this.isLeader) {
            this.loseLeadership();
        }
    }

    private handleLeaseDeletion() {
        if (!this.isLeader) {
            this.tryToBecomeLeader().catch((error) => {
                this.logger.error({
                    message: "Error while trying to become leader after lease deletion",
                    error,
                });
            });
        }
    }
}
