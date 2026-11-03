export class RunControl {
	fatal?: { reason: "provider_rejected"; httpStatus: number };
	reject(httpStatus: number): boolean {
		if (![401, 402, 403].includes(httpStatus) || this.fatal) return false;
		this.fatal = { reason: "provider_rejected", httpStatus };
		return true;
	}
	assertActive(): void {
		if (this.fatal) throw new Error(`Run stopped after provider HTTP ${this.fatal.httpStatus}; no further dispatch`);
	}
}
