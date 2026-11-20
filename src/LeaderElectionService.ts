import { ConfigurationOptions, CoordinationV1Api, KubeConfig, Observable, V1Lease, V1MicroTime, Watch } from "@kubernetes/client-node";
import { EventEmitter } from "events";
import { randomBytes } from "crypto";

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
    private readonly requestOptions: ConfigurationOptions = {
        middlewareMergeStrategy: "append",
        middleware: [{
            pre: (request) => {
                request.setSignal(AbortSignal.timeout(this.renewalInterval));
                return new Observable(Promise.resolve(request));
            },
            post: (response) => new Observable(Promise.resolve(response)),
        }],
    };
    private durationInSeconds: number;
    private isLeader = false;
    private electionInProgress = false;
    private leaseUpdateVersion = 0;
    private stopped = false;
    private initialized = false;
    private watchRequest: { abort(): void } | null = null;
    private watchRetryTimeout: NodeJS.Timeout | null = null;
    private readonly onSignal = () => { void this.gracefulShutdown(); };
    private leaseRenewalTimeout: NodeJS.Timeout | null = null;
    private leaseExpiryTimeout: NodeJS.Timeout | null = null;
    private notLeaderRetryTimeout: NodeJS.Timeout | null = null;
    private awaitLeadership: boolean;
    private readonly eventEmitter: EventEmitter;
    private readonly logger: Logger;
    LEADER_IDENTITY = `${process.env.HOSTNAME ?? "unknown"}-${randomBytes(16).toString("hex")}`;

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
        // Keep both renewal and expiry timers within Node's supported delay range.
        if (!Number.isInteger(this.renewalInterval) || this.renewalInterval < 1 || this.renewalInterval > 1_073_741_000) {
            throw new RangeError("renewalInterval must be an integer between 1 and 1073741000 milliseconds");
        }
        this.durationInSeconds = Math.ceil(2 * this.renewalInterval / 1000);
        this.awaitLeadership = options.awaitLeadership ?? false;
        this.eventEmitter = new EventEmitter();

        process.on("SIGINT", this.onSignal);
        process.on("SIGTERM", this.onSignal);
    }

    async initialize() {
        if (this.stopped) throw new Error("Leader election has been stopped");
        if (this.initialized) throw new Error("Leader election has already been initialized");
        this.initialized = true;
        const leadership = this.awaitLeadership && !this.isLeader ? new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                this.eventEmitter.removeListener("leaderElected", onElected);
                this.eventEmitter.removeListener("shutdown", onShutdown);
            };
            const onElected = () => {
                cleanup();
                resolve();
            };
            const onShutdown = () => {
                cleanup();
                reject(new Error("Leader election stopped before leadership was acquired"));
            };
            this.eventEmitter.once("leaderElected", onElected);
            this.eventEmitter.once("shutdown", onShutdown);
        }) : undefined;
        if (!process.env.KUBERNETES_SERVICE_HOST) {
            this.logger.info("Not running in Kubernetes, assuming leadership...");
            process.nextTick(() => {
                if (this.stopped) return;
                this.isLeader = true;
                this.emitLeaderElectedEvent();
            });
        } else {
            this.watchLeaseObject();

            this.runLeaderElectionProcess().catch((error) => {
                this.logger.error({
                    message: "Leader election process failed",
                    error,
                });
            });
        }
        await leadership;
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
        if (this.stopped || this.isLeader || this.electionInProgress) return;
        this.electionInProgress = true;
        const version = this.leaseUpdateVersion;
        this.logger.info("Trying to become leader...");
        try {
            let lease: V1Lease = await this.getLease();
            if (this.stopped || version !== this.leaseUpdateVersion) return;
            if (this.isLeaseExpired(lease) || !lease.spec?.holderIdentity || this.isLeaseHeldByUs(lease)) {
                this.logger.info("Lease expired or not held. Attempting to become leader...");
                lease = await this.acquireLease(lease);
            }
            // A newer ownership notification invalidates this request's result.
            if (version === this.leaseUpdateVersion && this.isLeaseHeldByUs(lease) && !this.isLeaseExpired(lease)) {
                this.becomeLeader(lease);
            }
        } catch (error) {
            this.logger.error({
                message: "Error while trying to become leader",
                error,
            });
        } finally {
            this.electionInProgress = false;
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

        const body = await this.kubeClient.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body: lease }, this.requestOptions);
        this.logger.info("Successfully acquired lease");
        return body;
    }

    private async renewLease() {
        if (this.stopped || !this.isLeader) return;
        const version = this.leaseUpdateVersion;
        try {
            const lease = await this.getLease();
            if (this.stopped || !this.isLeader || version !== this.leaseUpdateVersion) return;
            if (!this.isLeaseHeldByUs(lease)) {
                this.loseLeadership();
                return;
            }
            this.logger.debug("Renewing lease...");
            lease.spec!.renewTime = new V1MicroTime(new Date());
            const body = await this.kubeClient.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body: lease }, this.requestOptions);
            if (this.stopped || !this.isLeader || version !== this.leaseUpdateVersion) return;
            this.scheduleLeaseExpiry(body);
            this.logger.debug("Successfully renewed lease");
            return body;
        } catch (error) {
            this.logger.error({ message: "Error while renewing lease", error });
            if (version === this.leaseUpdateVersion) this.loseLeadership();
        }
    }

    private async getLease(): Promise<V1Lease> {
        try {
            return await this.kubeClient.readNamespacedLease({ name: this.leaseName, namespace: this.namespace }, this.requestOptions);
        } catch (error) {
            if (!this.stopped && (error as any)?.code === 404) {
                this.logger.info("Lease not found. Creating lease...");
                return this.createLease();
            }
            throw error;
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

        const body = await this.kubeClient.createNamespacedLease({ namespace: this.namespace, body: lease }, this.requestOptions);
        this.logger.info("Successfully created lease");
        return body;
    }

    private getLeaseExpiryTime(lease: V1Lease): number {
        const renewTime = lease.spec?.renewTime;
        if (!renewTime) return 0;
        const duration = lease.spec?.leaseDurationSeconds ?? this.durationInSeconds;
        const expiresAt = new Date(renewTime).getTime() + duration * 1000;
        return Number.isFinite(expiresAt) ? expiresAt : 0;
    }

    private isLeaseExpired(lease: V1Lease): boolean {
        return Date.now() >= this.getLeaseExpiryTime(lease);
    }

    private isLeaseHeldByUs(lease: V1Lease): boolean {
        return lease.spec?.holderIdentity === this.LEADER_IDENTITY;
    }

    public async gracefulShutdown() {
        if (this.stopped) return;
        this.stopped = true;
        this.eventEmitter.emit("shutdown");
        this.logger.info("Graceful shutdown initiated");
        const wasLeader = this.isLeader;
        if (this.leaseRenewalTimeout) clearTimeout(this.leaseRenewalTimeout);
        if (this.notLeaderRetryTimeout) clearTimeout(this.notLeaderRetryTimeout);
        if (this.watchRetryTimeout) clearTimeout(this.watchRetryTimeout);
        this.leaseRenewalTimeout = this.notLeaderRetryTimeout = this.watchRetryTimeout = null;
        this.watchRequest?.abort();
        this.watchRequest = null;
        process.removeListener("SIGINT", this.onSignal);
        process.removeListener("SIGTERM", this.onSignal);
        this.loseLeadership();
        if (wasLeader && this.kubeClient) {
            await this.releaseLease();
        }
    }

    private async releaseLease(): Promise<void> {
        try {
            const lease = await this.kubeClient.readNamespacedLease({ name: this.leaseName, namespace: this.namespace }, this.requestOptions);
            if (lease && this.isLeaseHeldByUs(lease)) {
                lease.spec!.holderIdentity = undefined;
                lease.spec!.renewTime = undefined;
                await this.kubeClient.replaceNamespacedLease({ name: this.leaseName, namespace: this.namespace, body: lease }, this.requestOptions);
                this.logger.info(`Lease for ${this.leaseName} released.`);
            }
        } catch (error) {
            if ((error as any)?.code === 404) return;
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

    private becomeLeader(lease: V1Lease) {
        if (this.stopped) return;
        if (!this.scheduleLeaseExpiry(lease)) return;
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
            this.leaseUpdateVersion++;
            if (this.leaseExpiryTimeout) clearTimeout(this.leaseExpiryTimeout);
            this.leaseExpiryTimeout = null;
            if (this.leaseRenewalTimeout) {
                clearTimeout(this.leaseRenewalTimeout);
                this.leaseRenewalTimeout = null;
            }
            this.emitLeadershipLostEvent();
            this.scheduleNotLeaderRetry();
        }
    }

    private scheduleNotLeaderRetry() {
        if (this.stopped || this.isLeader) return;
        if (this.notLeaderRetryTimeout) {
            clearTimeout(this.notLeaderRetryTimeout);
        }
        this.notLeaderRetryTimeout = setTimeout(() => this.runLeaderElectionProcess(), this.renewalInterval);
    }

    private async watchLeaseObject() {
        if (this.stopped) return;
        const reconnect = (error?: unknown) => {
            if (this.stopped) return;
            if (error) {
                this.logger.error({ message: "Lease watch failed; retrying in 5 seconds", error });
            } else {
                this.logger.info("Watch for lease gracefully closed");
            }
            this.watchRetryTimeout = setTimeout(() => this.watchLeaseObject(), 5000);
        };
        const path = `/apis/coordination.k8s.io/v1/namespaces/${this.namespace}/leases`;
        try {
            const request = await this.watch.watch(
                path,
                { fieldSelector: `metadata.name=${this.leaseName}` },
                (type, apiObj) => {
                    if (this.stopped || !apiObj || apiObj.metadata.name !== this.leaseName) return;
                    this.logger.debug(`Watch event type: ${type} for lease: ${this.leaseName}`);
                    switch (type) {
                        case "ADDED":
                        case "MODIFIED":
                            this.handleLeaseUpdate(apiObj);
                            break;
                        case "DELETED":
                            this.handleLeaseDeletion();
                            break;
                    }
                },
                reconnect,
            );
            if (this.stopped) request.abort();
            else this.watchRequest = request;
        } catch (err) {
            reconnect(err);
        }
    }

    private scheduleLeaseRenewal() {
        if (this.stopped) return;
        if (this.leaseRenewalTimeout) {
            clearTimeout(this.leaseRenewalTimeout);
        }

        this.leaseRenewalTimeout = setTimeout(async () => {
            this.leaseRenewalTimeout = null;
            const version = this.leaseUpdateVersion;
            if (this.isLeader) {
                try {
                    await this.renewLease();
                } catch (error) {
                    this.logger.error({ message: "Error while renewing lease", error });
                }
                if (this.isLeader && version === this.leaseUpdateVersion) {
                    this.scheduleLeaseRenewal();
                }
            }
        }, this.renewalInterval);
    }

    private scheduleLeaseExpiry(lease: V1Lease): boolean {
        if (this.leaseExpiryTimeout) clearTimeout(this.leaseExpiryTimeout);
        this.leaseExpiryTimeout = null;
        // Count from the timestamp written to the lease, not from the response arrival.
        const remaining = this.getLeaseExpiryTime(lease) - Date.now();
        if (remaining <= 0) {
            this.loseLeadership();
            return false;
        }
        this.leaseExpiryTimeout = setTimeout(() => this.loseLeadership(), remaining);
        return true;
    }

    private handleLeaseUpdate(leaseObj: V1Lease) {
        if (this.isLeaseHeldByUs(leaseObj)) {
            if (!this.isLeader) {
                this.tryToBecomeLeader();
            }
        } else {
            this.leaseUpdateVersion++;
            this.loseLeadership();
            if (!leaseObj.spec?.holderIdentity) {
                this.tryToBecomeLeader();
            }
        }
    }

    private handleLeaseDeletion() {
        this.leaseUpdateVersion++;
        this.loseLeadership();
        this.tryToBecomeLeader();
    }
}
